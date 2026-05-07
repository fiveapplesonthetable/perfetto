#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
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
"""End-to-end tests for BatchTraceProcessor and TpPool.

Required env:
  SHELL_PATH:  path to a built `trace_processor_shell` binary.
  ROOT_DIR:    perfetto source root (so we can find test/data fixtures).
"""

import concurrent.futures as cf
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

import pandas as pd

from perfetto.batch_trace_processor.api import (
    BatchTraceProcessor,
    BatchTraceProcessorConfig,
    FailureHandling,
)
from perfetto.batch_trace_processor.inputs import TracesWithMetadata
from perfetto.batch_trace_processor.pool import TpPool, TpPoolFailure
from perfetto.trace_processor.api import (
    TraceProcessor,
    TraceProcessorConfig,
    TraceProcessorException,
)
from perfetto.trace_uri_resolver import util as resolver_util
from perfetto.trace_uri_resolver.registry import ResolverRegistry
from perfetto.trace_uri_resolver.resolver import TraceUriResolver


def fixture():
  return os.path.join(os.environ['ROOT_DIR'], 'test', 'data',
                      'example_android_trace_30s.pb')


def small_fixture():
  return os.path.join(os.environ['ROOT_DIR'], 'test', 'data',
                      'sched_wakeup_trace.atr')


def base_config(**overrides) -> BatchTraceProcessorConfig:
  tp_config = TraceProcessorConfig(bin_path=os.environ['SHELL_PATH'])
  # Backward-compat for tests that predate the simplification: translate
  # the removed knobs into the surviving ones, then drop everything the
  # current dataclass doesn't accept.
  if 'max_loaded_traces' in overrides:
    n = overrides.pop('max_loaded_traces')
    if n is not None:
      # 256 MB per trace matches DEFAULT_PER_TRACE_MB in api.py.
      overrides.setdefault('memory_budget_mb', max(64, int(n) * 256))
  for dead in ('freeze_on_evict', 'cgroup_enabled', 'cgroup_memory_high_mb',
               'cgroup_memory_max_mb', 'cgroup_swap_max_mb',
               'per_trace_rlimit_as_mb', 'spill_dir_max_mb', 'disk_budget_mb'):
    overrides.pop(dead, None)
  return BatchTraceProcessorConfig(tp_config=tp_config, **overrides)


def _count_tp_subprocesses() -> int:
  """Best-effort count of trace_processor_shell children of this Python
  process. Used to assert no leaked subprocesses after close()."""
  try:
    out = subprocess.check_output(
        ['pgrep', '-c', '-P',
         str(os.getpid()), '-f', 'trace_processor_shell'],
        stderr=subprocess.DEVNULL)
    return int(out.strip() or 0)
  except subprocess.CalledProcessError:
    return 0


# --- TpPool -----------------------------------------------------------------


class TestTpPool(unittest.TestCase):

  def _resolve(self, paths):
    """Build pool-level Results that ARE reloadable (`_path` set)."""
    return [
        ResolverRegistry.Result(
            generator=resolver_util.file_generator(p),
            metadata={
                '_path': p,
                'idx': str(i)
            }) for i, p in enumerate(paths)
    ]

  def test_acquire_and_release(self):
    """Single trace, single acquire — basic sanity."""
    pool = TpPool(
        traces=self._resolve([fixture()]),
        tp_config=TraceProcessorConfig(bin_path=os.environ['SHELL_PATH']),
        max_loaded=1)
    try:
      with pool.acquire(0) as (tp, meta):
        self.assertIsInstance(tp, TraceProcessor)
        self.assertEqual(meta['idx'], '0')
        n = tp.query('select count(*) as n from slice').as_pandas_dataframe()
        self.assertGreater(int(n['n'].iloc[0]), 0)
      self.assertEqual(pool.handles[0].load_count, 1)
    finally:
      pool.close()

  def test_lru_eviction(self):
    """max_loaded=2, 4 traces, sequential acquires => 2 evictions
    occur on the way back to the first trace."""
    paths = [small_fixture()] * 4
    pool = TpPool(
        traces=self._resolve(paths),
        tp_config=TraceProcessorConfig(bin_path=os.environ['SHELL_PATH']),
        max_loaded=2)
    try:
      for i in range(4):
        with pool.acquire(i):
          pass
      # First two were evicted to make room for last two; load_count
      # for them is still 1.
      self.assertEqual([h.load_count for h in pool.handles], [1, 1, 1, 1])
      # Reload index 0 (was evicted) — load_count should bump to 2.
      with pool.acquire(0):
        pass
      self.assertEqual(pool.handles[0].load_count, 2)
    finally:
      pool.close()

  def test_concurrent_same_handle_coalesces(self):
    """Two threads acquiring the same evicted handle should coalesce
    into a single load (load_count increments by 1, not 2)."""
    paths = [small_fixture()]
    pool = TpPool(
        traces=self._resolve(paths),
        tp_config=TraceProcessorConfig(bin_path=os.environ['SHELL_PATH']),
        max_loaded=1)
    barrier = threading.Barrier(2)
    results = []

    def worker():
      barrier.wait()  # racing acquire
      with pool.acquire(0) as (tp, _meta):
        results.append(
            int(tp.query('select 1 as v').as_pandas_dataframe()['v'].iloc[0]))

    try:
      with cf.ThreadPoolExecutor(max_workers=2) as ex:
        list(ex.map(lambda _: worker(), range(2)))
      self.assertEqual(results, [1, 1])
      # Coalesced: the pool only loaded once across both racing threads.
      self.assertEqual(pool.handles[0].load_count, 1)
    finally:
      pool.close()

  def test_close_idempotent(self):
    pool = TpPool(
        traces=self._resolve([small_fixture()]),
        tp_config=TraceProcessorConfig(bin_path=os.environ['SHELL_PATH']),
        max_loaded=1)
    pool.close()
    pool.close()  # second call is a no-op
    with self.assertRaises(TpPoolFailure):
      with pool.acquire(0):
        pass


# --- BatchTraceProcessor: backwards-compat ---------------------------------


class TestBtpCompat(unittest.TestCase):

  def test_query_returns_one_df_per_trace(self):
    paths = [fixture(), fixture()]
    with BatchTraceProcessor(paths, base_config()) as btp:
      dfs = btp.query('select count(*) as n from slice')
    self.assertEqual(len(dfs), 2)
    for df in dfs:
      self.assertEqual(list(df.columns), ['n'])
      self.assertGreater(int(df['n'].iloc[0]), 0)

  def test_query_and_flatten_attaches_metadata(self):
    """`query_and_flatten` adds metadata columns (preserved from the
    pre-rework version)."""

    class TaggedResolver(TraceUriResolver):
      PREFIX = 'tagged'

      def resolve(self):
        return [
            TraceUriResolver.Result(trace=fixture(), metadata={'tag': 'a'}),
            TraceUriResolver.Result(trace=fixture(), metadata={'tag': 'b'}),
        ]

    with BatchTraceProcessor(TaggedResolver(), base_config()) as btp:
      df = btp.query_and_flatten('select 1 as one')
    self.assertEqual(set(df['tag']), {'a', 'b'})

  def test_execute_passes_through(self):
    with BatchTraceProcessor([fixture()], base_config()) as btp:
      result = btp.execute(lambda tp: tp.query('select 7 as x').
                           as_pandas_dataframe()['x'].iloc[0])
    self.assertEqual(result, [7])


# --- B1: load-failure cleanup ----------------------------------------------


class TestLoadFailureCleanup(unittest.TestCase):

  def test_raise_on_first_failure_closes_others(self):
    """Mix of valid + invalid trace paths with RAISE_EXCEPTION.

    Constructor must raise; all already-spawned subprocesses must be
    closed (no leaked trace_processor_shell processes)."""
    pre = _count_tp_subprocesses()
    bad = '/tmp/__nope__definitely_not_a_trace.bin'
    paths = [fixture(), bad, fixture(), fixture()]
    with self.assertRaises(Exception):
      BatchTraceProcessor(paths, base_config())
    # Give subprocesses a beat to actually exit.
    for _ in range(20):
      now = _count_tp_subprocesses()
      if now <= pre:
        break
      time.sleep(0.1)
    self.assertLessEqual(
        _count_tp_subprocesses(), pre,
        'load-failure path leaked trace_processor_shell '
        'subprocesses')

  def test_increment_stat_continues(self):
    bad = '/tmp/__nope__definitely_not_a_trace.bin'
    paths = [fixture(), bad, fixture()]
    cfg = base_config(load_failure_handling=FailureHandling.INCREMENT_STAT)
    with BatchTraceProcessor(paths, cfg) as btp:
      stats = btp.stats()
    self.assertGreaterEqual(stats.load_failures, 1)


# --- B2: HTTP-connection thread-safety -------------------------------------


class TestConcurrentQueriesSameTp(unittest.TestCase):

  def test_concurrent_queries_no_corruption(self):
    """Stress: 8 threads, 50 queries each, against the same TP.

    Pre-fix this corrupted the http.client connection (interleaved
    request/response on a single socket). Now the per-TP lock in
    TraceProcessorHttp serialises access."""
    with BatchTraceProcessor([fixture()], base_config()) as btp:

      def loop():
        for _ in range(50):
          dfs = btp.query('select 42 as v')
          self.assertEqual(int(dfs[0]['v'].iloc[0]), 42)

      with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(loop) for _ in range(8)]
        for f in futs:
          f.result()


# --- B3: close-during-query -----------------------------------------------


class TestCloseDuringQuery(unittest.TestCase):

  def test_close_does_not_deadlock(self):
    """Start a query in a worker, close from main, ensure both return
    in bounded time."""
    btp = BatchTraceProcessor([fixture()], base_config())
    started = threading.Event()
    done = threading.Event()

    def worker():
      started.set()
      try:
        btp.query('select count(*) from slice')
      except Exception:
        pass
      finally:
        done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    started.wait(5)
    btp.close()
    self.assertTrue(
        done.wait(10), 'worker did not return within 10s of close()')


# --- Phase 2: streaming + bounded memory -----------------------------------


class TestStreaming(unittest.TestCase):

  def test_query_iter_bounds_loaded_count(self):
    """With max_loaded=2 over 6 traces, the pool's loaded_count must
    never exceed 2 at any sampling point during a query_iter run."""
    paths = [small_fixture()] * 6
    cfg = base_config(max_loaded_traces=2)
    with BatchTraceProcessor(paths, cfg) as btp:
      observed: list = []
      stop = threading.Event()

      def sampler():
        while not stop.is_set():
          observed.append(btp._pool._loaded_count)
          time.sleep(0.01)

      t = threading.Thread(target=sampler, daemon=True)
      t.start()
      try:
        seen = 0
        for _meta, _df in btp.query_iter('select 1 as v'):
          seen += 1
        self.assertEqual(seen, 6)
      finally:
        stop.set()
        t.join()
      self.assertTrue(observed)
      self.assertLessEqual(
          max(observed), 2, f'pool exceeded max_loaded=2: {max(observed)}')

  def test_query_and_flatten_to_parquet_streams_to_disk(self):
    """Memory-safe flatten equivalent: writes to a single parquet
    dataset without ever materialising a whole-corpus df."""
    try:
      import pyarrow  # noqa: F401
    except ImportError:
      self.skipTest('parquet engine not installed (pip install pyarrow)')
    traces = TracesWithMetadata([
        (fixture(), {
            'device': 'pixel8',
            'tag': 'a'
        }),
        (fixture(), {
            'device': 'pixel7',
            'tag': 'b'
        }),
        (fixture(), {
            'device': 'pixel8',
            'tag': 'c'
        }),
    ])
    cfg = base_config(max_loaded_traces=1)
    with BatchTraceProcessor(traces, cfg) as btp, \
         tempfile.TemporaryDirectory() as d:
      out = btp.query_and_flatten_to_parquet('select count(*) as n from slice',
                                             Path(d))
      df = pd.read_parquet(out)
    # 3 rows (one per trace), with metadata columns flattened in.
    self.assertEqual(len(df), 3)
    self.assertEqual(set(df.columns), {'n', 'device', 'tag', '_path'})
    self.assertEqual(set(df['device']), {'pixel8', 'pixel7'})

  def test_spill_dir_used_as_default(self):
    try:
      import pyarrow  # noqa: F401
    except ImportError:
      self.skipTest('parquet engine not installed (pip install pyarrow)')
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(max_loaded_traces=2, spill_dir=Path(d))
      with BatchTraceProcessor([fixture()] * 2, cfg) as btp:
        out = btp.query_to_parquet('select 1 as v')  # no out_dir arg
      self.assertEqual(len(out), 2)
      for p in out:
        self.assertTrue(str(p).startswith(d))

  def test_query_to_parquet_writes_one_per_trace(self):
    try:
      import pyarrow  # noqa: F401
    except ImportError:
      try:
        import fastparquet  # noqa: F401
      except ImportError:
        self.skipTest('parquet engine not installed (pip install pyarrow)')
    paths = [small_fixture()] * 4
    cfg = base_config(max_loaded_traces=2)
    with BatchTraceProcessor(paths, cfg) as btp, \
         tempfile.TemporaryDirectory() as d:
      out = btp.query_to_parquet('select count(*) as n from slice', Path(d))
      self.assertEqual(len(out), 4)
      for p in out:
        self.assertTrue(p.exists())
        df = pd.read_parquet(p)
        self.assertEqual(list(df.columns)[0], 'n')


# --- B7: executor shutdown -------------------------------------------------


class TestExecutorShutdown(unittest.TestCase):

  def test_close_shuts_down_query_executor(self):
    btp = BatchTraceProcessor([fixture()], base_config())
    self.assertFalse(btp._query_executor._shutdown)
    btp.close()
    self.assertTrue(btp._query_executor._shutdown)


# --- Bounded pool eviction observable via stats ---------------------------


class TestEvictionStats(unittest.TestCase):

  def test_reload_count_reflects_evictions(self):
    """max_loaded=1, 3 traces => the second loop touches each trace
    twice; the second pass must reload (load_count == 2 per handle).

    Forces close+reload via `freeze_on_evict=False` — by default the
    cgroup v2 freezer preserves state across eviction (load_count
    would stay at 1, freeze_count goes up). See `TestFreezeMode` in
    the v2 suite for the freeze-preserves-state assertion."""
    paths = [small_fixture()] * 3
    cfg = base_config(max_loaded_traces=1, freeze_on_evict=False)
    with BatchTraceProcessor(paths, cfg) as btp:
      list(btp.query_iter('select 1'))
      list(btp.query_iter('select 1'))
      counts = [h.load_count for h in btp._pool.handles]
    self.assertEqual(counts, [2, 2, 2])


# --- R1: per-trace metadata flows through to flatten ----------------------


class TestPerTraceMetadata(unittest.TestCase):

  def test_metadata_columns_in_flatten(self):
    traces = TracesWithMetadata([
        (fixture(), {
            'device': 'pixel8',
            'scenario': 'cold'
        }),
        (fixture(), {
            'device': 'pixel7',
            'scenario': 'warm'
        }),
    ])
    with BatchTraceProcessor(traces, base_config()) as btp:
      df = btp.query_and_flatten('select 1 as v')
    self.assertEqual(set(df.columns), {'v', 'device', 'scenario', '_path'})
    self.assertEqual(set(df['device']), {'pixel8', 'pixel7'})
    pixel8 = df[df['device'] == 'pixel8']
    self.assertEqual(set(pixel8['scenario']), {'cold'})

  def test_pre_filter_subset(self):
    """Caller filters their (path, meta) list to query only a subset."""
    all_traces = [
        (fixture(), {
            'device': 'pixel8'
        }),
        (fixture(), {
            'device': 'pixel7'
        }),
        (fixture(), {
            'device': 'pixel8'
        }),
    ]
    pixel8 = TracesWithMetadata(
        [t for t in all_traces if t[1]['device'] == 'pixel8'])
    with BatchTraceProcessor(pixel8, base_config()) as btp:
      dfs = btp.query('select 1')
    self.assertEqual(len(dfs), 2)


# --- R2: LRU across queries (memory budget) -------------------------------


class TestLruAcrossQueries(unittest.TestCase):

  def test_loaded_count_capped_across_repeated_queries(self):
    """Run query_iter 3 times against 6 traces with max_loaded=2.

    The pool's `loaded_count` must never exceed 2 at any sample point
    across the entire span — i.e. LRU eviction is enforced not just
    within a single query but across queries (which is what 'memory
    budget' actually means)."""
    paths = [small_fixture()] * 6
    cfg = base_config(max_loaded_traces=2)
    with BatchTraceProcessor(paths, cfg) as btp:
      observed: list = []
      stop = threading.Event()

      def sampler():
        while not stop.is_set():
          observed.append(btp._pool._loaded_count)
          time.sleep(0.005)

      t = threading.Thread(target=sampler, daemon=True)
      t.start()
      try:
        for _ in range(3):
          for _meta, _df in btp.query_iter('select 1 as v'):
            pass
      finally:
        stop.set()
        t.join()
      self.assertTrue(observed)
      self.assertLessEqual(
          max(observed), 2, f'pool exceeded max_loaded=2: {max(observed)}')


if __name__ == '__main__':
  unittest.main()
