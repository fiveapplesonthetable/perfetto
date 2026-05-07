#!/usr/bin/env python3
# Copyright (C) 2021 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""BatchTraceProcessor: run ad-hoc SQL across many Perfetto traces.

Minimal model: one `trace_processor_shell` subprocess per trace,
managed in an LRU pool. When the pool is full and a query needs an
unloaded trace, the LRU shell is killed; the trace is re-parsed when
something queries it again.

Two knobs:
  * `memory_budget_mb` — derives the slot count via a per-trace
    estimate. Lower it to evict; raise it to keep more loaded.
  * `query_workers` (a.k.a. `cpu_workers`) — query parallelism.

Optional `session_dir` adds a SQLite store under `btp.sqlite` that
persists every per-trace query result. Re-running the same SQL on the
same trace returns rows from SQLite without spawning a shell. Survives
`kill -9`. Wipe by deleting the directory — no in-app cache control.
"""

from __future__ import annotations

import abc
import concurrent.futures as cf
import contextlib
import dataclasses as dc
import http.client
import logging
import os
import tempfile
import threading
import time
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import pandas as pd

try:
  import polars as pl
  HAS_POLARS = True
except ModuleNotFoundError:
  HAS_POLARS = False
except ImportError:
  HAS_POLARS = False

from perfetto.batch_trace_processor.defaults import (
    auto_cpu_workers,
    auto_memory_budget_mb,
    load_config_json,
    save_config_json,
    total_machine_cores,
    total_machine_memory_mb,
)
from perfetto.batch_trace_processor.failure import (
    FAILURE_KINDS,
    FailureLog,
    TraceFailure,
    format_failure,
)
from perfetto.batch_trace_processor.linux import ulimit_check
from perfetto.batch_trace_processor.platform import PlatformDelegate
from perfetto.batch_trace_processor.pool import (
    TpPool,
    TpPoolFailure,
    TpPoolMissingFile,
)
from perfetto.batch_trace_processor.progress import Progress, ProgressTracker
from perfetto.batch_trace_processor.session import (
    Session,
    fingerprint_traces,
    query_id_for,
)
from perfetto.common.exceptions import PerfettoException
from perfetto.trace_processor.api import PLATFORM_DELEGATE as TP_PLATFORM_DELEGATE
from perfetto.trace_processor.api import TraceProcessor
from perfetto.trace_processor.api import TraceProcessorException
from perfetto.trace_processor.api import TraceProcessorConfig
from perfetto.trace_processor.shell import (
    LoadFailedError as _LoadFailedError,
    LoadTimeoutError as _LoadTimeoutError,
)
from perfetto.trace_uri_resolver import registry
from perfetto.trace_uri_resolver.registry import ResolverRegistry

PLATFORM_DELEGATE = PlatformDelegate

TraceListReference = registry.TraceListReference
Metadata = Dict[str, str]

# Cap on parallel loads (FS thrashing limit).
MAX_LOAD_WORKERS = 32
# Conservative per-trace RAM estimate. Used to derive a slot count
# from `memory_budget_mb`. 256 MB matches a small-to-medium trace's
# parsed-state footprint inside `trace_processor_shell`.
DEFAULT_PER_TRACE_MB = 256

log = logging.getLogger('perfetto.btp')


class _PoolMaintainer:
  """Background thread doing two cheap maintenance tasks every 500 ms:

    1. Reap loaded handles whose shell died out-of-band (orphan,
       OOM-kill). Without this, /info would keep reporting handles as
       `loaded` while their procs are gone.
    2. Eagerly warm one evicted handle when there are free slots, so
       raising `memory_budget_mb` visibly grows the loaded count
       without waiting for a query to acquire each handle.

  One operation per tick is intentional — we don't want to monopolise
  the query executor with bulk warmups. Steady-state, after ~N ticks
  every evicted handle is loaded (where N = empty slots at the time
  of the bump)."""

  POLL_INTERVAL_S = 0.5

  def __init__(self,
               pool,
               warmup_cb: Optional[Callable[[], bool]] = None) -> None:
    self._pool = pool
    self._warmup_cb = warmup_cb
    self._stop = threading.Event()
    self._thread: Optional[threading.Thread] = None

  def start(self) -> None:
    self._thread = threading.Thread(
        target=self._run, name='btp-maint', daemon=True)
    self._thread.start()

  def stop(self) -> None:
    self._stop.set()
    if self._thread is not None:
      self._thread.join(timeout=2)

  def _run(self) -> None:
    while not self._stop.is_set():
      try:
        self._pool.sweep_dead_handles()
      except Exception:  # noqa: BLE001
        log.debug('sweep_dead_handles failed', exc_info=True)
      if self._warmup_cb is not None:
        try:
          self._warmup_cb()
        except Exception:  # noqa: BLE001
          log.debug('eager warmup failed', exc_info=True)
      self._stop.wait(self.POLL_INTERVAL_S)


def _affinity_cpu_count() -> int:
  """cpu_count that respects cgroup affinity (containers).

  `multiprocessing.cpu_count()` reports host cores irrespective of
  cgroup quota; on a 64-core host with a 4-cpu container quota the old
  code would spawn 64 workers. `os.sched_getaffinity` (Linux) reflects
  the actual usable set."""
  if hasattr(os, 'sched_getaffinity'):
    try:
      return max(1, len(os.sched_getaffinity(0)))
    except OSError:
      pass
  return max(1, os.cpu_count() or 1)


class FailureHandling(Enum):
  """How to handle per-trace load/execute failures."""
  RAISE_EXCEPTION = 0
  INCREMENT_STAT = 1


@dc.dataclass
class BatchTraceProcessorConfig:
  tp_config: TraceProcessorConfig = dc.field(
      default_factory=TraceProcessorConfig)
  load_failure_handling: FailureHandling = FailureHandling.RAISE_EXCEPTION
  execute_failure_handling: FailureHandling = FailureHandling.RAISE_EXCEPTION

  # Soft RAM budget in MB. Maps to a count cap on the pool via a
  # conservative per-trace estimate (DEFAULT_PER_TRACE_MB). When the
  # pool is full, the LRU handle is closed and re-loaded on demand.
  # `None` => derived from host RAM via `auto_memory_budget_mb()`.
  memory_budget_mb: Optional[int] = None

  # Query parallelism. `None` => 50% of usable cores (auto_cpu_workers).
  # User-facing name in the HTTP/CLI surface is `cpu_workers`; we keep
  # the internal `query_workers` for backward compatibility but treat
  # them as one knob.
  query_workers: Optional[int] = None

  # Per-query wallclock timeout in seconds. A query exceeding this is
  # cancelled by closing the offending TP's HTTP connection; the trace
  # is marked failed and the run continues. Default: 15 minutes.
  query_timeout_s: float = 15 * 60

  # Where streaming APIs persist intermediate output. Defaults to a
  # tmp dir created on first use.
  spill_dir: Optional[Path] = None

  # Persistent session directory. When set, a SQLite at
  # `session_dir/btp.sqlite` stores every query's per-trace result and
  # survives `kill -9`. Constructing with the same dir on a later run
  # transparently returns the same rows for known (sql, traces).
  # No size cap — wipe the directory to reset.
  session_dir: Optional[Path] = None


@dc.dataclass
class Stats:
  load_failures: int = 0
  execute_failures: int = 0
  # Total reload events (cold acquires after eviction). 0 for an
  # all-resident pool.
  reloads: int = 0
  # Structured per-trace failure records. Same list as
  # `BatchTraceProcessor.failures()`.
  failures: List[TraceFailure] = dc.field(default_factory=list)
  # `cgroup` if the cgroup+swap path is in use; `lru` for the
  # close-and-reload fallback; `unbounded` if no budget was set.
  pool_mode: str = 'unbounded'
  # Cumulative cgroup OOM-kill count seen by this BTP, if cgroup is
  # in use. Always 0 for the LRU fallback.
  oom_kills: int = 0


class BatchTraceProcessor:
  """Run ad-hoc SQL queries across many Perfetto traces.

  Usage (unchanged):
    with BatchTraceProcessor(traces) as btp:
      dfs = btp.query('select * from slice')
      for df in dfs:
        print(df)

  Memory-bounded usage:
    cfg = BatchTraceProcessorConfig(memory_budget_mb=2048)
    with BatchTraceProcessor(huge_list, cfg) as btp:
      for meta, df in btp.query_iter('select count(*) as n from slice'):
        ...
  """

  class Observer(abc.ABC):

    @abc.abstractmethod
    def trace_processed(self, metadata: Metadata,
                        execution_time_seconds: float):
      raise NotImplementedError

  def __init__(self,
               traces: TraceListReference,
               config: BatchTraceProcessorConfig = BatchTraceProcessorConfig(),
               observer: Optional['BatchTraceProcessor.Observer'] = None):
    self._stats = Stats()
    self._failures = FailureLog()
    self._progress = ProgressTracker()
    self._session: Optional[Session] = None
    self._server: Optional[object] = None  # BtpServer; lazy import
    self._cancel_event = threading.Event()
    self.observer = observer
    self.config = config
    self.closed = False

    self.platform_delegate = PLATFORM_DELEGATE()
    self.tp_platform_delegate = TP_PLATFORM_DELEGATE()

    # Defaults derived from machine resources, applied only where the
    # user didn't override. Two knobs: cpu_workers + memory_budget_mb,
    # each defaulting to 50% of the corresponding machine resource so
    # ad-hoc usage doesn't starve other tools on the box.
    if config.memory_budget_mb is None:
      config.memory_budget_mb = auto_memory_budget_mb()
    if config.query_workers is None:
      config.query_workers = auto_cpu_workers()

    # Inherit a resolver registry across child TPs (preserves prior
    # contract).
    self.resolver_registry = (
        config.tp_config.resolver_registry or
        self.tp_platform_delegate.default_resolver_registry())
    self.config.tp_config.resolver_registry = self.resolver_registry

    resolved = self.resolver_registry.resolve(traces)
    ulimit_check(len(resolved))

    cpus = _affinity_cpu_count()
    workers = config.query_workers or cpus
    self._query_executor = (
        self.platform_delegate.create_query_executor(len(resolved)) or
        cf.ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix='btp-query'))

    raise_load = (
        config.load_failure_handling == FailureHandling.RAISE_EXCEPTION)
    # The pool runs LRU close-and-reload. Slot count = how many TPs may
    # be simultaneously loaded; derived from `memory_budget_mb` via a
    # conservative per-trace estimate. When a query needs a slot and
    # all are taken, the LRU TP is closed; the next query that touches
    # that trace re-spawns and re-parses.
    pool_max = max(
        1, min(len(resolved), config.memory_budget_mb // DEFAULT_PER_TRACE_MB))
    self._pool = TpPool(
        traces=resolved,
        tp_config=config.tp_config,
        max_loaded=pool_max,
        raise_load_failures=raise_load,
    )
    self._stats.pool_mode = 'lru'
    log.info('btp: lru mode (memory_budget_mb=%d -> %d slots)',
             config.memory_budget_mb, pool_max)

    # Background maintenance: reap dead shells, eagerly warm one
    # evicted handle per tick when there's slot capacity.
    self._maintainer = _PoolMaintainer(
        self._pool, warmup_cb=self._try_warm_one_evicted)
    self._maintainer.start()

    # Optional durable session. Construction is idempotent against
    # session_dir contents — past queries are visible immediately.
    if config.session_dir is not None:
      self._session = Session(Path(config.session_dir))
      fps = fingerprint_traces([h.metadata for h in self._pool.handles])
      self._session.upsert_traces(fps, [h.metadata for h in self._pool.handles])

    # Eager-warmup loads every trace upfront so a bad input fails
    # fast in the constructor rather than on first query — long-
    # standing public-API contract preserved by the unit tests
    # (TestLoadFailureCleanup, test_btp_load_failure*). The pressure
    # monitor catches up after warmup completes; on very tight
    # budgets the kernel cgroup may OOM-kill mid-warmup, surfacing
    # as the same load-failure path tests already exercise.
    if self._pool.max_loaded >= len(resolved) and len(resolved) > 0:
      self._eager_warmup()

  def _eager_warmup(self) -> None:
    """Load every trace upfront (preserves prior fail-fast semantics
    for the unbounded-pool case)."""
    cpus = _affinity_cpu_count()
    max_load_workers = min(cpus, MAX_LOAD_WORKERS)
    load_executor = (
        self.platform_delegate.create_load_executor(len(self._pool)) or
        cf.ThreadPoolExecutor(
            max_workers=max_load_workers, thread_name_prefix='btp-load'))
    raise_load = (
        self.config.load_failure_handling == FailureHandling.RAISE_EXCEPTION)
    futures = [
        load_executor.submit(self._warmup_one, i)
        for i in range(len(self._pool))
    ]
    failed: List[BaseException] = []
    try:
      for fut in cf.as_completed(futures):
        ex = fut.exception()
        if ex is None:
          continue
        if raise_load:
          # Cancel pending, fall through to teardown. Already-running
          # futures finish; we close their TPs in `close()` below.
          for f in futures:
            f.cancel()
          failed.append(ex)
          break
        # INCREMENT_STAT: counted by the pool's internal failure path.
        self._stats.load_failures = self._pool.load_failures
    finally:
      load_executor.shutdown(wait=True)
    if failed:
      self.close()
      raise failed[0]
    self._stats.load_failures = self._pool.load_failures

  def _warmup_one(self, index: int) -> None:
    with self._pool.acquire(index):
      pass

  def _try_warm_one_evicted(self) -> bool:
    """Pick one evicted handle that fits in current slot capacity and
    submit a load on the query executor. Called from the maintainer
    once per tick. Best-effort: silently bails if the pool is full,
    no evicted handles remain, the chosen handle is non-reloadable,
    or the executor is shutting down."""
    if self.closed:
      return False
    pool = self._pool
    target_idx: Optional[int] = None
    with pool._lock:  # noqa: SLF001
      if pool._loaded_count >= pool._max_loaded:  # noqa: SLF001
        return False
      for h in pool.handles:
        if h.state == 'evicted' and h.reloadable and h.index not in (
            pool._failed):  # noqa: SLF001
          target_idx = h.index
          break
    if target_idx is None:
      return False
    try:
      self._query_executor.submit(self._warmup_one, target_idx)
      return True
    except Exception:  # noqa: BLE001
      return False

  # -- Public API ---------------------------------------------------------

  def metric(self, metrics: List[str]):
    return self.execute(lambda tp: tp.metric(metrics))

  def query(self, sql: str):
    """List of pandas DataFrames, one per trace, in input order.

    Cache-aware when `session_dir` is set: identical (sql, traces)
    inputs return from the durable cache instantly."""
    return list(self._sql_into_input_order(sql))

  def query_and_flatten(self, sql: str):
    """Concatenated DataFrame in input order with metadata columns."""
    parts: List[Optional[pd.DataFrame]] = [None] * len(self._pool)
    metas: List[Metadata] = [{}] * len(self._pool)
    for idx, meta, df in self._sql_into_input_order_with_meta(sql):
      metas[idx] = meta
      parts[idx] = df
    out: List[pd.DataFrame] = []
    for idx, df in enumerate(parts):
      if df is None:
        continue
      df = df.copy()
      for k, v in metas[idx].items():
        df[k] = v
      out.append(df)
    if not out:
      return pd.DataFrame()
    return pd.concat(out).reset_index(drop=True)

  def query_polars(self, sql: str):
    if not HAS_POLARS:
      raise PerfettoException(
          'polars dependency missing. Please run `pip3 install polars`')
    return self.execute(lambda tp: tp.query(sql).as_polars_dataframe())

  def query_and_flatten_polars(self, sql: str):
    if not HAS_POLARS:
      raise PerfettoException(
          'polars dependency missing. Please run `pip3 install polars`')
    return self.execute_and_flatten_polars(
        lambda tp: tp.query(sql).as_polars_dataframe())

  def query_single_result(self, sql: str):

    def inner(tp: TraceProcessor):
      df = tp.query(sql).as_pandas_dataframe()
      if len(df.index) != 1:
        raise TraceProcessorException('Query should only return a single row')
      if len(df.columns) != 1:
        raise TraceProcessorException(
            'Query should only return a single column')
      return df.iloc[0, 0]

    return self.execute(inner)

  def execute(self, fn: Callable[[TraceProcessor], Any]) -> List[Any]:
    """Run `fn` against every trace, return results in INPUT order.

    Historical contract: the i-th element of the returned list
    corresponds to the i-th trace in the input. Failures surface in
    input order (first failing trace raises first under RAISE_EXCEPTION).
    """
    out = [None] * len(self._pool)
    for idx, _meta, val in self._execute_input_order(fn):
      out[idx] = val
    return out

  def execute_and_flatten(
      self, fn: Callable[[TraceProcessor], pd.DataFrame]) -> pd.DataFrame:
    """Run `fn` and concat the per-trace DataFrames in INPUT order,
    attaching every metadata key as a column."""
    parts: List[Optional[pd.DataFrame]] = [None] * len(self._pool)
    for idx, meta, df in self._execute_input_order(fn):
      for k, v in meta.items():
        df[k] = v
      parts[idx] = df
    kept = [p for p in parts if p is not None]
    if not kept:
      return pd.DataFrame()
    return pd.concat(kept).reset_index(drop=True)

  def execute_and_flatten_polars(self, fn: Callable[[TraceProcessor],
                                                    Any]) -> Any:
    if not HAS_POLARS:
      raise PerfettoException(
          'polars dependency missing. Please run `pip3 install polars`')
    parts: List[Any] = [None] * len(self._pool)
    for idx, meta, df in self._execute_input_order(fn):
      for k, v in meta.items():
        df = df.with_columns(pl.lit(v).alias(k))
      parts[idx] = df
    return pl.concat([p for p in parts if p is not None])

  # -- New streaming APIs -------------------------------------------------

  def query_iter(self, sql: str) -> Iterator[Tuple[Metadata, pd.DataFrame]]:
    """Stream (metadata, df) pairs as each per-trace query completes.

    Peak memory is bounded by `memory_budget_mb`; suitable for 10s of
    thousands of traces. Cache-aware when `session_dir` is set."""
    if self._session is None:
      yield from self._execute_iter_with_meta(
          lambda tp: tp.query(sql).as_pandas_dataframe())
      return
    fps = fingerprint_traces([h.metadata for h in self._pool.handles])
    qid = query_id_for(sql, fps)
    yield from self._cached_query_iter(sql, qid, fps)

  def query_and_flatten_to_parquet(self,
                                   sql: str,
                                   out_path: Optional[Path] = None) -> Path:
    """Run `sql` across every trace and APPEND each per-trace df
    (with metadata columns) to a single parquet dataset on disk.

    Memory-safe equivalent of `query_and_flatten` for huge corpora —
    no whole-corpus DataFrame is materialised. Returns the directory
    of part files (parquet dataset)."""
    try:
      import pyarrow as pa
      import pyarrow.parquet as pq
    except ImportError as ex:
      raise PerfettoException(
          'query_and_flatten_to_parquet requires `pyarrow`. Install '
          'with `pip install pyarrow`.') from ex
    if out_path is None:
      out_path = (
          self.config.spill_dir if self.config.spill_dir is not None else Path(
              tempfile.mkdtemp(prefix='btp-flatten-')))
    out_path = Path(out_path)
    out_path.mkdir(parents=True, exist_ok=True)
    writer: Optional[pq.ParquetWriter] = None
    schema: Optional[pa.Schema] = None
    try:
      for i, (meta, df) in enumerate(self.query_iter(sql)):
        for k, v in meta.items():
          df[k] = v
        if df.empty:
          continue
        table = pa.Table.from_pandas(df, preserve_index=False)
        if writer is None:
          schema = table.schema
          writer = pq.ParquetWriter(out_path / 'part.parquet', schema)
        else:
          # Schemas may diverge across traces (different metadata
          # value types, e.g.). Cast to the first-seen schema.
          table = table.cast(schema)
        writer.write_table(table)
    finally:
      if writer is not None:
        writer.close()
    return out_path

  def query_to_parquet(self,
                       sql: str,
                       out_dir: Optional[Path] = None) -> List[Path]:
    """Run `sql` across every trace, writing one parquet per trace.

    `out_dir` defaults to `config.spill_dir` if set, else a fresh
    temp dir under `$TMPDIR`. Requires pyarrow or fastparquet; raises
    PerfettoException with a pip hint if neither is installed.
    Returns the list of files written, in completion order."""
    if out_dir is None:
      out_dir = (
          self.config.spill_dir if self.config.spill_dir is not None else Path(
              tempfile.mkdtemp(prefix='btp-spill-')))
    try:
      import pyarrow  # noqa: F401
    except ImportError:
      try:
        import fastparquet  # noqa: F401
      except ImportError as ex:
        raise PerfettoException(
            'query_to_parquet requires `pyarrow` (preferred) or '
            '`fastparquet`. Install with `pip install pyarrow`.') from ex
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: List[Tuple[int, Path]] = []
    for i, (meta, df) in enumerate(self.query_iter(sql)):
      path = out_dir / f'trace_{i:06d}.parquet'
      for k, v in meta.items():
        df[k] = v
      df.to_parquet(path)
      written.append((i, path))
    written.sort(key=lambda p: p[0])
    return [p for _, p in written]

  # -- Structured failure inspection ----------------------------------------

  def failures(self) -> List[TraceFailure]:
    """All per-trace failure records since construction.

    Includes: load timeouts, parse errors, OOM kills, query timeouts,
    TP crashes, RLIMIT trips, query errors. Always populated, even
    under FailureHandling.RAISE_EXCEPTION (the exception bubbles up
    AND a record is appended)."""
    return self._failures.all()

  def failures_df(self) -> pd.DataFrame:
    """Failures as a pandas DataFrame, with metadata flattened into
    top-level columns:

        df = btp.failures_df()
        df[df['kind'] == 'oom_killed']
        df[df['device'] == 'pixel8']
    """
    return pd.DataFrame(self._failures.to_records())

  def print_failures(self) -> None:
    import sys as _sys
    for f in self._failures.all():
      print(format_failure(f), file=_sys.stderr)

  # -- Progress / status ----------------------------------------------------

  def progress(self) -> Progress:
    """Snapshot of in-flight execution; safe from any thread."""
    return self._progress.snapshot()

  def info(self) -> Dict[str, Any]:
    """High-level "what is this BTP" payload + realtime pool stats."""
    # Snapshot the pool state under its lock so the counts are
    # internally consistent (loaded + evicted sums to trace_count
    # minus the count of permanently-failed handles).
    pool = self._pool
    with pool._lock:  # noqa: SLF001
      loaded = sum(1 for h in pool.handles if h.state == 'loaded')
      loading = sum(1 for h in pool.handles if h.state == 'loading')
      evicted = sum(1 for h in pool.handles if h.state == 'evicted')
      total_reloads = sum(max(0, h.load_count - 1) for h in pool.handles)
      running = sum(1 for h in pool.handles if h.pin_count > 0)
      running_handles = [{
          'handle_idx': h.index,
          '_path': h.metadata.get('_path', ''),
          'state': h.state,
          'pin_count': h.pin_count,
          'load_count': h.load_count,
      } for h in pool.handles if h.pin_count > 0]
    sess_dir = self.config.session_dir

    # Sum of per-shell VmRSS, so the UI can show "X MB resident".
    # Pool-driven slot accounting is the eviction signal; this number
    # is purely for the user.
    memory_used_mb = self._pool.memory_used_mb()

    return {
        'pool_mode': self._stats.pool_mode,
        'trace_count': len(self._pool),
        'max_loaded': self._pool.max_loaded,
        'session_dir': str(sess_dir) if sess_dir is not None else None,
        'cpu_workers': self.config.query_workers,
        'memory_budget_mb': self.config.memory_budget_mb,
        'query_timeout_s': self.config.query_timeout_s,
        'machine_cores_total': total_machine_cores(),
        'machine_memory_mb_total': total_machine_memory_mb(),
        # Legacy alias kept for older clients. Prefer `cpu_workers`.
        'workers': self.config.query_workers,
        'loaded': loaded,
        'loading': loading,
        'evicted': evicted,
        'running': running,
        'running_handles': running_handles,
        'memory_used_mb': memory_used_mb,
        'total_reloads': total_reloads,
        'load_failures': pool.load_failures,
        'failure_counts': self._failures.count_by_kind(),
    }

  def pool_handle_snapshot(self) -> List[Dict[str, Any]]:
    """Lock-protected per-handle state snapshot. Used by the HTTP
    server to render the live traces table without reaching into the
    pool's internals."""
    return self._pool.snapshot_handles()

  # -- Session: list / replay / export --------------------------------------

  @property
  def session(self) -> Optional[Session]:
    return self._session

  def list_queries(self) -> List[Any]:
    if self._session is None:
      return []
    return self._session.list_queries()

  def replay(self, query_id: str) -> pd.DataFrame:
    if self._session is None:
      raise PerfettoException(
          'replay() requires `session_dir` to be set in the config.')
    parts = []
    for handle_idx, df in self._session.iter_results(query_id):
      df = df.copy()
      df['_handle_idx'] = handle_idx
      parts.append(df)
    if not parts:
      return pd.DataFrame()
    return pd.concat(parts).reset_index(drop=True)

  def export(self, query_id: str, out_path: Path) -> Path:
    if self._session is None:
      raise PerfettoException(
          'export() requires `session_dir` to be set in the config.')
    df = self.replay(query_id)
    out_path = Path(out_path)
    df.to_parquet(out_path)
    return out_path

  # -- Convenience for the HTTP server / agents ------------------------------

  def run_query(self, sql: str) -> str:
    """Run `sql` across every trace, store + cache results, return
    a stable `query_id`. Used by the HTTP server's POST /run.

    Per-trace failures (missing file, dead shell, query error) are
    recorded into the failure log and the offending trace yields an
    empty df — the run as a whole still succeeds and returns a
    query_id. The caller checks `/failures` to see what went wrong."""
    fps = fingerprint_traces([h.metadata for h in self._pool.handles])
    qid = query_id_for(sql, fps)
    saved = self.config.execute_failure_handling
    self.config.execute_failure_handling = FailureHandling.INCREMENT_STAT
    try:
      list(self._cached_query_iter(sql, qid, fps))
    finally:
      self.config.execute_failure_handling = saved
    return qid

  def cancel(self) -> None:
    self._cancel_event.set()

  def config_dict(self) -> Dict[str, Any]:
    from perfetto.batch_trace_processor.defaults import _to_jsonable
    return _to_jsonable(self.config)

  def update_config(self, partial: Dict[str, Any]) -> None:
    """Apply a partial config dict at runtime. The user-facing budget
    pair (cpu_workers / memory_budget_mb) is honoured live where the
    underlying machinery permits:

      * query_timeout_s   — instant, applies to the next query.
      * cpu_workers       — resizes the query thread pool by swapping
                            in a new ThreadPoolExecutor; in-flight
                            tasks on the old pool finish first.
      * memory_budget_mb  — re-derives the slot cap on the pool.
                            Existing handles stay loaded until the new
                            cap squeezes them out via LRU.

    Anything else is recorded against the durable session (so a future
    BTP construction can pick it up) but doesn't take effect until then.
    """
    # Accept the user-facing alias `cpu_workers` as a write to
    # `query_workers` (internal name).
    if 'cpu_workers' in partial:
      partial = dict(partial)
      partial['query_workers'] = partial.pop('cpu_workers')

    LIVE_SIMPLE = {'query_timeout_s'}
    for k, v in partial.items():
      if hasattr(self.config, k) and k in LIVE_SIMPLE:
        setattr(self.config, k, v)
      if self._session is not None:
        self._session.set_config(k, str(v))

    if 'query_workers' in partial:
      n = max(1, int(partial['query_workers']))
      self.config.query_workers = n
      old = self._query_executor
      new_ex = (
          self.platform_delegate.create_query_executor(len(self._pool)) or
          cf.ThreadPoolExecutor(max_workers=n, thread_name_prefix='btp-query'))
      self._query_executor = new_ex
      # Drain old pool out-of-band so live queries finish; don't block
      # the reconfigure call.
      threading.Thread(
          target=lambda: old.shutdown(wait=True),
          name='btp-old-executor-shutdown',
          daemon=True).start()
      log.info('btp: cpu_workers=%d (executor swapped)', n)

    if 'memory_budget_mb' in partial:
      mb = max(64, int(partial['memory_budget_mb']))
      self.config.memory_budget_mb = mb
      new_slots = max(1, min(len(self._pool), mb // DEFAULT_PER_TRACE_MB))
      self._pool.set_max_loaded(new_slots)
      log.info('btp: memory_budget_mb=%d (-> %d slots)', mb, new_slots)

  def add_trace(self,
                path: str,
                metadata: Optional[Dict[str, str]] = None) -> int:
    """Register a new trace at `path` with optional `metadata`. Returns
    the new handle index. Cheap: no parse, no SQL. The trace will be
    loaded on first acquire (or first query that touches it).

    Idempotent on `(path, metadata)`: re-registering the same path with
    the same metadata is a no-op and returns the existing index. This
    makes the watcher/poll path safe to call repeatedly."""
    abs_path = str(Path(path).resolve())
    new_meta = dict(metadata or {})
    new_meta.setdefault('_path', abs_path)
    # Idempotency check.
    for h in self._pool.handles:
      if h.metadata.get('_path') == abs_path:
        return h.index
    # Resolve via the registry so the new trace gets the same generator
    # plumbing as the original corpus. TracesWithMetadata is the
    # documented (path, meta) -> Result adapter.
    from perfetto.batch_trace_processor.inputs import TracesWithMetadata
    resolved = self.resolver_registry.resolve(
        TracesWithMetadata([(abs_path, new_meta)]))
    if not resolved:
      raise PerfettoException(f'failed to resolve trace at {abs_path!r}')
    idx = self._pool.add_trace(resolved[0])
    if self._session is not None:
      # `upsert_traces` is a full re-sync (DELETE+INSERT), so we hand
      # it the COMPLETE handle list — passing only the new row would
      # silently drop everything else.
      all_metas = [h.metadata for h in self._pool.handles]
      self._session.upsert_traces(fingerprint_traces(all_metas), all_metas)
    log.info('btp: add_trace idx=%d path=%s', idx, abs_path)
    return idx

  def declared_paths(self) -> List[str]:
    """All paths currently registered with the pool (one per handle)."""
    return [h.metadata.get('_path', '') for h in self._pool.handles]

  def save_config(self, path: Path) -> None:
    save_config_json(self.config, Path(path))

  def serve(self, host: str = '127.0.0.1', port: int = 0) -> str:
    """Start an HTTP/JSON server on `host:port`. Returns the bound
    URL. Single instance per BTP — calling twice closes the old."""
    from perfetto.batch_trace_processor.server import BtpServer
    if self._server is not None:
      try:
        self._server.close()  # type: ignore[attr-defined]
      except Exception:  # noqa: BLE001
        pass
    self._server = BtpServer(self, host=host, port=port)
    log.info('btp.serve listening at %s',
             self._server.url)  # type: ignore[attr-defined]
    return self._server.url  # type: ignore[attr-defined]

  # -- Internals ----------------------------------------------------------

  def _sql_into_input_order(self, sql: str) -> Iterator[pd.DataFrame]:
    """Yield per-trace DataFrames for `sql` in INPUT order. Uses the
    session cache when available."""
    for _idx, _meta, df in self._sql_into_input_order_with_meta(sql):
      yield df

  def _sql_into_input_order_with_meta(
      self, sql: str) -> Iterator[Tuple[int, Metadata, pd.DataFrame]]:
    """Same shape as `_execute_input_order` but cache-aware."""
    if self._session is None:
      # No cache: keep historical behaviour.
      yield from self._execute_input_order(
          lambda tp: tp.query(sql).as_pandas_dataframe())
      return
    # Drive results through the cache; collect into idx-indexed slots
    # so we can yield in input order at the end.
    fps = fingerprint_traces([h.metadata for h in self._pool.handles])
    qid = query_id_for(sql, fps)
    parts: List[Optional[pd.DataFrame]] = [None] * len(self._pool)
    # We need a (handle_idx, df) pair, not (meta, df). The cache
    # iterator yields (meta, df); we recover idx by handle identity.
    # Easier: iterate the cache iterator and find idx via a meta map.
    meta_to_idx: Dict[int, int] = {
        id(h.metadata): i for i, h in enumerate(self._pool.handles)
    }
    for meta, df in self._cached_query_iter(sql, qid, fps):
      idx = meta_to_idx.get(id(meta))
      if idx is None:
        # Fall back to value-equality lookup (rare).
        for i, h in enumerate(self._pool.handles):
          if h.metadata == meta:
            idx = i
            break
      assert idx is not None
      parts[idx] = df
    for idx, df in enumerate(parts):
      if df is None:
        continue
      yield idx, self._pool.handles[idx].metadata, df

  def _query_timeout_or_none(self) -> Optional[float]:
    t = self.config.query_timeout_s
    return None if t is None or t <= 0 else float(t)

  def _assert_healthy(self) -> None:
    """Cheap pre-flight on every query path. Raises if the BTP is in
    a state where timeouts can't be honoured (executor wedged, pool
    closed, cgroup unexpectedly missing). The intent is "fail loud
    rather than silently drop guarantees" — preferable to a runaway
    that the user thinks is bounded.
    """
    if self.closed:
      raise TraceProcessorException(
          'BatchTraceProcessor is closed; further queries are rejected.')
    ex = self._query_executor
    if getattr(ex, '_shutdown', False):
      raise TraceProcessorException(
          'btp executor was shut down; cannot honour timeouts.')

  def _cached_query_iter(
      self, sql: str, query_id: str,
      fingerprints) -> Iterator[Tuple[Metadata, pd.DataFrame]]:
    """Cache-aware query iterator. Yields (metadata, df) pairs in
    completion order. Cache hits stream from the session
    immediately; misses are dispatched and written back."""
    self._assert_healthy()
    if self._session is None:
      yield from self._execute_iter_with_meta(
          lambda tp: tp.query(sql).as_pandas_dataframe())
      return

    self._session.begin_query(query_id, sql, len(self._pool))
    cached = set(self._session.cached_handles(query_id))
    self._progress.begin(query_id, sql, len(self._pool))

    for idx in sorted(cached):
      meta = self._pool.handles[idx].metadata
      df = self._session.fetch_result(query_id, idx)
      self._progress.step(failed=False)
      yield meta, df if df is not None else pd.DataFrame()

    misses = [i for i in range(len(self._pool)) if i not in cached]
    if misses:
      fn = lambda tp: tp.query(sql).as_pandas_dataframe()
      futures = {
          self._query_executor.submit(self._run_on_handle, i, fn): i
          for i in misses
      }
      timeout = self._query_timeout_or_none()
      deadline = (None if timeout is None else time.monotonic() + timeout)
      try:
        for fut in cf.as_completed(futures):
          if self._cancel_event.is_set():
            break
          idx = futures[fut]
          meta = self._pool.handles[idx].metadata
          try:
            fut_timeout = (None if deadline is None else max(
                0.0, deadline - time.monotonic()))
            df = fut.result(timeout=fut_timeout)
          except cf.TimeoutError:
            df = self._handle_query_timeout(idx, meta)
          except _ExecuteFailure as wrap:
            df = pd.DataFrame()
            log.debug('execute failure on %s: %s', meta, wrap.cause)
          try:
            self._session.store_result(
                query_id, idx, df, time.time(), error=None)
          except Exception:  # noqa: BLE001
            log.warning(
                'store_result failed for q=%s idx=%d',
                query_id,
                idx,
                exc_info=True)
          self._progress.step(failed=False)
          yield meta, df
      finally:
        for fut in futures:
          if not fut.done():
            fut.cancel()

    self._session.complete_query(query_id)
    self._progress.end()

  def _handle_query_timeout(self, idx: int, meta: Metadata) -> pd.DataFrame:
    """Record a query_timeout failure and force-close the offending
    TP so a hung shell can't block subsequent queries."""
    self._failures.add(
        TraceFailure(
            handle_idx=idx,
            metadata=meta,
            kind='query_timeout',
            detail=f'query exceeded {self.config.query_timeout_s}s'))
    self._stats.execute_failures += 1
    try:
      h = self._pool.handles[idx]
      tp = h.tp
      if tp is not None:
        tp.close()
    except Exception:  # noqa: BLE001
      pass
    return pd.DataFrame()

  def _execute_iter_inner(
      self, fn: Callable[[TraceProcessor],
                         Any]) -> Iterator[Tuple[int, Metadata, Any]]:
    """Submit one task per handle, yield (idx, meta, val) in
    COMPLETION order. Callers project to (meta, val) for streaming or
    reorder by idx for input-order semantics."""
    self._assert_healthy()
    # One future per handle. Each task acquires its slot in the pool,
    # runs fn, releases. With max_loaded < trace_count the pool's
    # acquire blocks until a slot frees, providing natural backpressure.
    futures = {
        self._query_executor.submit(self._run_on_handle, i, fn): i
        for i in range(len(self._pool))
    }
    try:
      for fut in cf.as_completed(futures):
        idx = futures[fut]
        meta = self._pool.handles[idx].metadata
        try:
          val = fut.result()
        except _ExecuteFailure as wrap:
          # Counted in stats; surface empty df for INCREMENT_STAT.
          val = pd.DataFrame()
          log.debug('execute failure on %s: %s', meta, wrap.cause)
        yield idx, meta, val
    finally:
      for fut in futures:
        if not fut.done():
          fut.cancel()

  def _execute_input_order(
      self, fn: Callable[[TraceProcessor],
                         Any]) -> Iterator[Tuple[int, Metadata, Any]]:
    """Submit one task per handle, yield (idx, meta, val) in INPUT
    order (waiting on each future in submit order). Failures raise
    in input order, matching the pre-rework `executor.map(...)`
    semantics."""
    self._assert_healthy()
    futures = [
        self._query_executor.submit(self._run_on_handle, i, fn)
        for i in range(len(self._pool))
    ]
    try:
      for i, fut in enumerate(futures):
        meta = self._pool.handles[i].metadata
        try:
          val = fut.result()
        except _ExecuteFailure as wrap:
          val = pd.DataFrame()
          log.debug('execute failure on %s: %s', meta, wrap.cause)
        yield i, meta, val
    finally:
      for fut in futures:
        if not fut.done():
          fut.cancel()

  def _execute_iter_with_meta(
      self, fn: Callable[[TraceProcessor],
                         Any]) -> Iterator[Tuple[Metadata, Any]]:
    """Streaming variant: yields in COMPLETION order so a slow trace
    doesn't hold up faster ones. Used by `query_iter` /
    `query_to_parquet`."""
    for _idx, meta, val in self._execute_iter_inner(fn):
      yield meta, val

  def _run_on_handle(self, index: int, fn: Callable[[TraceProcessor],
                                                    Any]) -> Any:
    raise_exec = (
        self.config.execute_failure_handling == FailureHandling.RAISE_EXCEPTION)
    start = time.time()
    handle_meta = self._pool.handles[index].metadata
    # Allow at most one transparent retry on shell death. trace_processor
    # query() loads the whole result in-memory and only touches
    # client-side state, so re-running on a fresh shell is safe.
    for crash_attempt in range(2):
      try:
        with self._pool.acquire(index) as (tp, meta):
          val = fn(tp)
        break
      except (ConnectionError, OSError, http.client.HTTPException) as ex:
        stale_tp = self._pool.invalidate(index)
        if stale_tp is not None:
          try:
            stale_tp.close()
          except Exception:  # noqa: BLE001
            pass
        if crash_attempt == 0:
          log.info('btp: %s shell died mid-query, retrying once', handle_meta)
          continue
        kind = 'tp_crash'
        self._failures.add(
            TraceFailure(
                handle_idx=index,
                metadata=handle_meta,
                kind=kind,
                detail=f'{type(ex).__name__}: {ex}'))
        self._record_in_session(index, kind, str(ex))
        if raise_exec:
          raise TraceProcessorException(
              f'{handle_meta} TP crashed mid-query: {ex}') from None
        self._stats.execute_failures += 1
        raise _ExecuteFailure(ex)
      except TpPoolFailure as ex:
        # Pool-level acquire failure (missing file, permanently failed
        # handle). Caught BEFORE TraceProcessorException because it's
        # a subclass — wrong order would misclassify these as
        # 'query_error'.
        kind = ('missing_file'
                if isinstance(ex, TpPoolMissingFile) else 'load_failed')
        self._failures.add(
            TraceFailure(
                handle_idx=index,
                metadata=handle_meta,
                kind=kind,
                detail=str(ex)))
        self._record_in_session(index, kind, str(ex))
        if raise_exec:
          raise TraceProcessorException(f'{handle_meta} {ex}') from None
        self._stats.execute_failures += 1
        raise _ExecuteFailure(ex)
      except TraceProcessorException as ex:
        # Query reported a SQL or runtime error — not retryable.
        self._failures.add(
            TraceFailure(
                handle_idx=index,
                metadata=handle_meta,
                kind='query_error',
                detail=str(ex)))
        self._record_in_session(index, 'query_error', str(ex))
        if raise_exec:
          raise TraceProcessorException(f'{handle_meta} {ex}') from None
        self._stats.execute_failures += 1
        raise _ExecuteFailure(ex)
      except _LoadTimeoutError as ex:
        stderr_tail = getattr(ex, 'stderr_tail', None)
        self._failures.add(
            TraceFailure(
                handle_idx=index,
                metadata=handle_meta,
                kind='load_timeout',
                detail=str(ex),
                stderr_tail=stderr_tail))
        self._record_in_session(index, 'load_timeout', str(ex))
        if raise_exec:
          raise TraceProcessorException(f'{handle_meta} {ex}') from None
        self._stats.execute_failures += 1
        raise _ExecuteFailure(ex)
      except _LoadFailedError as ex:
        kind = 'load_failed'
        self._failures.add(
            TraceFailure(
                handle_idx=index,
                metadata=handle_meta,
                kind=kind,
                detail=str(ex),
                exit_code=getattr(ex, 'exit_code', None),
                stderr_tail=getattr(ex, 'stderr_tail', None)))
        self._record_in_session(index, kind, str(ex))
        if raise_exec:
          raise TraceProcessorException(f'{handle_meta} {ex}') from None
        self._stats.execute_failures += 1
        raise _ExecuteFailure(ex)
    if self.observer:
      self.observer.trace_processed(handle_meta, time.time() - start)
    return val

  def _record_in_session(self, idx: int, kind: str, detail: str) -> None:
    if self._session is None:
      return
    try:
      self._session.store_failure(
          idx, kind, detail, exit_code=None, stderr_tail=None)
    except Exception:  # noqa: BLE001
      log.debug('store_failure failed', exc_info=True)

  def stats(self) -> Stats:
    self._stats.load_failures = self._pool.load_failures
    self._stats.failures = self._failures.all()
    return self._stats

  def close(self) -> None:
    """Closes this BatchTraceProcessor. Idempotent.

    Order: maintainer (stop polling) -> server (no new requests) ->
    query executor (drain in-flight) -> pool (kill TPs) -> session
    (commit + close DB)."""
    if self.closed:
      return
    self.closed = True
    try:
      self._maintainer.stop()
    except Exception:  # noqa: BLE001
      pass
    if self._server is not None:
      try:
        self._server.close()  # type: ignore[attr-defined]
      except Exception:  # noqa: BLE001
        pass
      self._server = None
    try:
      self._query_executor.shutdown(wait=True, cancel_futures=True)
    except TypeError:
      self._query_executor.shutdown(wait=True)
    self._pool.close()
    if self._session is not None:
      try:
        self._session.close()
      except Exception:  # noqa: BLE001
        pass

  def __enter__(self) -> 'BatchTraceProcessor':
    return self

  def __exit__(self, *args) -> bool:
    self.close()
    return False

  def __del__(self) -> None:
    try:
      self.close()
    except Exception:
      pass


class _ExecuteFailure(Exception):
  """Internal sentinel: per-handle execute failure that must be
  surfaced as an empty df under INCREMENT_STAT, not raised."""

  def __init__(self, cause: BaseException):
    self.cause = cause
