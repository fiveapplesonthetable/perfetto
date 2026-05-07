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
"""LRU-managed pool of TraceProcessor subprocesses.

`BatchTraceProcessor` historically held one `trace_processor_shell`
subprocess per input trace, all alive concurrently. This breaks down at
~1k traces (subprocess + memory cost) and offers no knob to bound the
working set.

`TpPool` holds N input traces but keeps at most `max_loaded` of them
materialised at any one time. A query against an unloaded trace
transparently re-loads it (spawning a fresh shell, re-parsing the
source) after evicting the LRU unpinned entry. When `max_loaded >=
len(traces)` the pool degenerates to the previous behaviour: every
trace is loaded once and stays loaded.

State machine for a single handle:

    evicted --[acquire]--> loading --[load_ok]--> loaded
        ^                       |                    |
        |                       v                    |
        +-- failed -- evicted <--+                   |
        |                                            |
        +----[evict from LRU when slot needed]-------+

A handle in `loaded` is reference-counted via `pin_count`; eviction
candidates are picked from `state == loaded and pin_count == 0` in LRU
order. Concurrent acquires for the same trace coalesce: only the first
loads, the rest wait on the shared condition.
"""

from __future__ import annotations

import collections
import contextlib
import dataclasses as dc
import logging
import threading
from pathlib import Path
from typing import Iterator, List, Optional, Tuple

from perfetto.trace_processor.api import (
    TraceProcessor,
    TraceProcessorConfig,
    TraceProcessorException,
)
from perfetto.trace_uri_resolver import util
from perfetto.trace_uri_resolver.registry import ResolverRegistry
from perfetto.trace_uri_resolver.resolver import TraceUriResolver

Metadata = dict
log = logging.getLogger('perfetto.btp.pool')


@dc.dataclass
class _Handle:
  """One slot in the pool. Most fields are guarded by the pool's lock;
  `tp` may only be touched while either holding the lock or owning a
  pin (i.e. inside an `acquire` block).

  `trace` carries the original ResolverRegistry.Result. Its `generator`
  is single-shot (consumed by the first parse). For subsequent reloads
  after eviction we re-derive the bytes from `metadata['_path']` if
  present (paths are the typical bulk-batch input). If `_path` is
  absent the handle is non-reloadable: once loaded, it stays pinned
  forever (max_loaded effectively shrinks)."""
  index: int
  trace: ResolverRegistry.Result
  metadata: Metadata
  state: str = 'evicted'  # 'evicted' | 'loading' | 'loaded'
  tp: Optional[TraceProcessor] = None
  pin_count: int = 0
  # Number of times this handle has been (re)loaded.
  load_count: int = 0
  # First-load uses the original generator, subsequent loads recreate
  # it from `_path` metadata (or fail if not reloadable).
  _first_load: bool = True

  @property
  def reloadable(self) -> bool:
    return '_path' in self.metadata


class TpPoolFailure(TraceProcessorException):
  """Raised when a pool operation fails irrecoverably."""


class TpPoolMissingFile(TpPoolFailure):
  """Raised when a handle's `_path` no longer exists on disk. Treated
  as transient: the next acquire retries (so a deleted-and-re-created
  trace recovers seamlessly), and we don't permanently mark the
  handle failed under INCREMENT_STAT mode."""


class TpPool:
  """Bounded pool of TraceProcessor subprocesses.

  Construction is cheap: it does not load anything. Loading happens
  lazily on `acquire`. Use as a context manager to guarantee close.
  """

  def __init__(self,
               traces: List[ResolverRegistry.Result],
               tp_config: TraceProcessorConfig,
               max_loaded: Optional[int] = None,
               raise_load_failures: bool = True):
    """
    Args:
      traces: resolved trace references (each will become one handle).
      tp_config: passed to every TraceProcessor we spawn.
      max_loaded: hard cap on simultaneously-loaded TPs. `None` means
        "all" (every trace stays loaded; backward-compatible).
      raise_load_failures: if False, a load failure marks the handle
        permanently failed rather than propagating to the caller.
    """
    self._tp_config = tp_config
    self._handles: List[_Handle] = [
        _Handle(index=i, trace=t, metadata=t.metadata)
        for i, t in enumerate(traces)
    ]
    self._max_loaded = (
        len(self._handles) if max_loaded is None else max(1, max_loaded))
    self._raise_load_failures = raise_load_failures

    self._lock = threading.Lock()
    self._cv = threading.Condition(self._lock)
    # Insertion-ordered: first key = oldest. Holds every handle
    # currently in `loaded` or `loading` state.
    self._lru: 'collections.OrderedDict[int, None]' = collections.OrderedDict()
    self._loaded_count = 0  # loaded + loading (both consume a slot)
    self._closed = False
    # Permanent load-failure markers (handle index -> last exception).
    self._failed: dict = {}
    self.load_failures = 0

  def __len__(self) -> int:
    return len(self._handles)

  @property
  def handles(self) -> List[_Handle]:
    return self._handles

  @property
  def max_loaded(self) -> int:
    return self._max_loaded

  def set_max_loaded(self, n: int) -> None:
    """Live-resize the slot cap. Increasing wakes any waiters; shrinking
    is best-effort — handles already loaded stay loaded until naturally
    evicted by a future acquire that needs the slot."""
    with self._lock:
      self._max_loaded = max(1, int(n))
      self._cv.notify_all()

  def snapshot_handles(self) -> List[dict]:
    """Lock-protected snapshot of every handle's live state. Returns a
    list of dicts safe to serialise (state + counters + metadata).
    Avoids forcing callers to reach into `_lock` / `_handles`."""
    out: List[dict] = []
    with self._lock:
      for h in self._handles:
        rec = {
            'handle_idx': h.index,
            'state': h.state,
            'pin_count': h.pin_count,
            'load_count': h.load_count,
            'metadata': dict(h.metadata or {}),
        }
        out.append(rec)
    return out

  def sweep_dead_handles(self) -> int:
    """Reap loaded handles whose trace_processor_shell process has
    exited unexpectedly (e.g. orphan, OOM-kill, etc.) while no query
    was in flight. Without this sweep, the pool would keep claiming
    the handle is "loaded" until the next query attempts to use it.

    Returns the number of handles invalidated this pass."""
    swept = 0
    victims: List[TraceProcessor] = []
    with self._lock:
      for h in self._handles:
        if h.state != 'loaded' or h.tp is None or h.pin_count > 0:
          continue
        sp = getattr(h.tp, 'subprocess', None)
        if sp is None:
          continue
        try:
          alive = sp.poll() is None
        except Exception:  # noqa: BLE001
          alive = True
        if alive:
          continue
        # Dead. Move to evicted; queue the stale TP for close().
        victims.append(h.tp)
        h.tp = None
        h.state = 'evicted'
        self._lru.pop(h.index, None)
        self._loaded_count = max(0, self._loaded_count - 1)
        swept += 1
      if swept > 0:
        self._cv.notify_all()
    # Best-effort close outside the lock — process is gone, this just
    # cleans up local fds.
    for tp in victims:
      try:
        tp.close()
      except Exception:  # noqa: BLE001
        pass
    return swept

  def invalidate(self, index: int) -> Optional[TraceProcessor]:
    """Mark a handle's TP as dead so the next acquire respawns it.

    Called from the api layer when a query fails because the shell
    crashed or its connection was closed (kernel OOM kill, external
    SIGKILL, etc). The handle is moved to `evicted` state and its
    slot is released; the stale TP object is returned so the caller
    can attempt a graceful close() outside the lock (it'll likely
    short-circuit since the process is gone, but it cleans up local
    file descriptors)."""
    if self._closed:
      return None
    with self._lock:
      handle = self._handles[index]
      stale_tp = handle.tp
      if handle.state in ('loaded', 'loading'):
        handle.state = 'evicted'
        handle.tp = None
        self._lru.pop(index, None)
        self._loaded_count = max(0, self._loaded_count - 1)
        self._cv.notify_all()
      return stale_tp

  def add_trace(self, trace: ResolverRegistry.Result) -> int:
    """Append a new handle (live-add). Returns its index. Thread-safe.

    Any in-flight queries iterate `len(self)`, so the next query after
    this returns sees the new handle. We deliberately don't try to
    splice into an in-flight query — the caller wants a clean
    "registered, ready for next query" semantics."""
    if self._closed:
      raise TpPoolFailure('pool is closed; cannot add_trace')
    with self._lock:
      idx = len(self._handles)
      self._handles.append(
          _Handle(index=idx, trace=trace, metadata=trace.metadata))
      # Slot-cap adjustment, if any, is the api layer's job.
      self._cv.notify_all()
      return idx

  @contextlib.contextmanager
  def acquire(self, index: int) -> Iterator[Tuple[TraceProcessor, Metadata]]:
    """Yield the TraceProcessor for handle `index`, loading it if
    necessary. Pins the handle for the duration of the block."""
    if self._closed:
      raise TpPoolFailure('pool is closed')
    handle = self._handles[index]

    # Phase 1: become the loader, or wait for the loaded state.
    must_load = False
    tp_to_close: Optional[TraceProcessor] = None
    with self._lock:
      while True:
        if self._closed:
          raise TpPoolFailure('pool is closed')
        if index in self._failed:
          raise TpPoolFailure(f'handle {index} previously failed to load: '
                              f'{self._failed[index]}')
        if handle.state == 'loaded':
          handle.pin_count += 1
          self._lru.move_to_end(index)  # most-recently-used
          break
        if handle.state == 'loading':
          # Another thread is loading this exact handle; wait.
          self._cv.wait()
          continue
        # state == 'evicted'. Need a free slot.
        if self._loaded_count >= self._max_loaded:
          tp_to_close = self._try_evict_unpinned_locked()
          if tp_to_close is None:
            # All loaded handles are pinned; wait for a release.
            self._cv.wait()
            continue
          # Slot freed and we still hold the lock, so no other thread
          # can have grabbed it. Fall through to "take the slot."
        # Take the slot.
        handle.state = 'loading'
        self._loaded_count += 1
        self._lru[index] = None
        must_load = True
        break

    # Free the evicted TP outside the pool lock — its close() can take
    # up to ~2s on SIGTERM-timeout, which would otherwise stall every
    # waiter.
    if tp_to_close is not None:
      try:
        tp_to_close.close()
      except Exception:
        log.warning('error closing evicted TP', exc_info=True)

    if must_load:
      try:
        tp = self._spawn(handle)
      except Exception as ex:
        with self._lock:
          handle.state = 'evicted'
          self._loaded_count -= 1
          self._lru.pop(index, None)
          self._cv.notify_all()
          if self._raise_load_failures:
            raise
          # Missing-file is transient — don't permanently fail the
          # handle so the trace recovers when the file comes back.
          if not isinstance(ex, TpPoolMissingFile):
            self._failed[index] = repr(ex)
          self.load_failures += 1
        raise
      with self._lock:
        handle.tp = tp
        handle.state = 'loaded'
        handle.load_count += 1
        handle.pin_count += 1
        self._cv.notify_all()

    try:
      yield handle.tp, handle.metadata
    finally:
      with self._lock:
        handle.pin_count -= 1
        if handle.pin_count == 0:
          self._cv.notify_all()

  def _try_evict_unpinned_locked(self) -> Optional[TraceProcessor]:
    """Evict the LRU unpinned, RELOADABLE `loaded` handle. Caller must
    hold the lock. Returns the TP to close (the caller closes it
    OUTSIDE the lock). Returns None if no candidate exists.

    Non-reloadable handles (no `_path` metadata) are skipped: their
    bytes are gone after first parse, so evicting them would lose the
    trace."""
    for idx in list(self._lru):
      h = self._handles[idx]
      if h.state == 'loaded' and h.pin_count == 0 and h.reloadable:
        tp = h.tp
        h.tp = None
        h.state = 'evicted'
        self._loaded_count -= 1
        self._lru.pop(idx, None)
        return tp
    return None

  def memory_used_mb(self) -> int:
    """Sum VmRSS (in MB) across every alive trace_processor_shell
    subprocess this pool owns. Read from `/proc/PID/status`; cheap.
    Used by the UI's memory bar to show real resident-set usage."""
    total_kb = 0
    with self._lock:
      pids = []
      for h in self._handles:
        if h.state != 'loaded' or h.tp is None:
          continue
        sp = getattr(h.tp, 'subprocess', None)
        if sp is None:
          continue
        pids.append(sp.pid)
    for pid in pids:
      try:
        with open(f'/proc/{pid}/status', 'r') as f:
          for line in f:
            if line.startswith('VmRSS:'):
              total_kb += int(line.split()[1])
              break
      except (OSError, ValueError):
        continue
    return total_kb // 1024

  def _spawn(self, handle: _Handle) -> TraceProcessor:
    """Build a TraceProcessor for `handle`.

    First load uses the original (single-shot) generator from the
    resolver. Subsequent loads recreate the byte stream from
    `metadata['_path']`. We pre-check that the file still exists so a
    deleted-on-disk trace fails with a clean message instead of
    blowing up inside the trace_processor_shell mid-parse."""
    path = handle.metadata.get('_path')
    if path:
      try:
        exists = Path(path).is_file()
      except OSError:
        exists = False
      if not exists:
        raise TpPoolMissingFile(
            f'trace file is gone: {path!r} (handle {handle.index}). '
            'Will retry on next acquire if the file returns.')
    if handle._first_load:
      generator = handle.trace.generator
      handle._first_load = False
    else:
      if not path:
        raise TpPoolFailure(
            f'handle {handle.index} is not reloadable: source has no '
            '_path metadata. Raise memory_budget_mb so the pool keeps '
            'this trace loaded, or hold the trace bytes externally.')
      generator = util.file_generator(path)

    class _SingleResolver(TraceUriResolver):
      """Returns exactly one already-resolved trace reference."""

      def __init__(self, gen, metadata: Metadata):
        self._gen = gen
        self._metadata = metadata

      def resolve(self) -> List['TraceUriResolver.Result']:
        return [
            TraceUriResolver.Result(
                trace=self._gen,
                metadata=self._metadata,
            )
        ]

    tp = TraceProcessor(
        trace=_SingleResolver(generator, handle.metadata),
        config=self._tp_config)
    return tp

  def close(self) -> None:
    """Close every loaded TP. Idempotent."""
    with self._lock:
      if self._closed:
        return
      self._closed = True
      to_close: List[TraceProcessor] = []
      for h in self._handles:
        if h.tp is not None:
          to_close.append(h.tp)
          h.tp = None
        h.state = 'evicted'
      self._loaded_count = 0
      self._lru.clear()
      self._cv.notify_all()
    for tp in to_close:
      try:
        tp.close()
      except Exception:
        log.warning('error closing TP during pool shutdown', exc_info=True)

  def __enter__(self) -> 'TpPool':
    return self

  def __exit__(self, *args) -> None:
    self.close()
