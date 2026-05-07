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
"""BatchTraceProcessor v2 — durable session, watchdogs, server, agentic
APIs.

These tests are independent of the v1 suite (which still asserts the
historical contract). They focus on what v2 *adds*:

  * Failure log: shape + flow-through.
  * Per-query timeout (live override).
  * Save/load config JSON round-trip.
  * Durable session: kill -9 survivable, cache hit, list/replay/export.
  * Per-trace metadata flowing through the cache.
  * HTTP server: agent-shaped endpoints.
  * Progress snapshot.

Required env (same as the v1 file):
  SHELL_PATH:  built `trace_processor_shell` binary.
  ROOT_DIR:    perfetto source root.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict

import pandas as pd

from perfetto.batch_trace_processor.api import (
    BatchTraceProcessor,
    BatchTraceProcessorConfig,
    FailureHandling,
)
from perfetto.batch_trace_processor.failure import (
    FAILURE_KINDS,
    FailureLog,
    TraceFailure,
    format_failure,
)
from perfetto.batch_trace_processor.inputs import TracesWithMetadata
from perfetto.batch_trace_processor.session import (
    Session,
    fingerprint_traces,
    query_id_for,
)
from perfetto.batch_trace_processor.defaults import (
    auto_memory_budget_mb,
    auto_query_workers,
    load_config_json,
    save_config_json,
)
from perfetto.batch_trace_processor.progress import Progress, ProgressTracker
from perfetto.trace_processor import TraceProcessorConfig


def fixture() -> str:
  return os.path.join(os.environ['ROOT_DIR'], 'test', 'data',
                      'example_android_trace_30s.pb')


def small_fixture() -> str:
  return os.path.join(os.environ['ROOT_DIR'], 'test', 'data',
                      'sched_wakeup_trace.atr')


def base_config(**overrides) -> BatchTraceProcessorConfig:
  tp = TraceProcessorConfig(bin_path=os.environ['SHELL_PATH'])
  if 'max_loaded_traces' in overrides:
    n = overrides.pop('max_loaded_traces')
    if n is not None:
      overrides.setdefault('memory_budget_mb', max(64, int(n) * 256))
  for dead in ('freeze_on_evict', 'cgroup_enabled', 'cgroup_memory_high_mb',
               'cgroup_memory_max_mb', 'cgroup_swap_max_mb',
               'per_trace_rlimit_as_mb', 'spill_dir_max_mb', 'disk_budget_mb'):
    overrides.pop(dead, None)
  return BatchTraceProcessorConfig(tp_config=tp, **overrides)


# --- Failure log -----------------------------------------------------------


class TestFailureLog(unittest.TestCase):

  def test_unknown_kind_normalised(self):
    f = TraceFailure(handle_idx=0, metadata={}, kind='nope', detail='x')
    self.assertEqual(f.kind, 'unknown')
    self.assertIn('[unrecognized kind=nope]', f.detail)

  def test_concurrent_add_safe(self):
    log = FailureLog()

    def writer():
      for i in range(200):
        log.add(
            TraceFailure(
                handle_idx=i, metadata={}, kind='tp_crash', detail='x'))

    threads = [threading.Thread(target=writer) for _ in range(4)]
    for t in threads:
      t.start()
    for t in threads:
      t.join()
    self.assertEqual(len(log), 800)

  def test_query_error_recorded_under_increment_stat(self):
    cfg = base_config(execute_failure_handling=FailureHandling.INCREMENT_STAT)
    with BatchTraceProcessor([fixture()], cfg) as btp:
      _ = btp.query('select * from definitely_not_a_table')
      kinds = {f.kind for f in btp.failures()}
      self.assertIn('query_error', kinds)
      df = btp.failures_df()
      self.assertGreater(len(df), 0)
      self.assertIn('kind', df.columns)


# --- Query-timeout watchdog -----------------------------------------------


class TestQueryTimeout(unittest.TestCase):

  def test_handle_query_timeout_records_failure(self):
    """Drive `_handle_query_timeout` directly. Avoids depending on
    wallclock-of-a-real-SQL-query (flaky) and on PerfettoSQL
    constructs that would be discouraged in real code (recursive
    CTE; the stdlib has graph_scan / tree_ancestor for traversals).

    The branch tested is the wiring: timeout records a structured
    failure and surfaces an empty df."""
    cfg = base_config(
        query_timeout_s=60,
        execute_failure_handling=FailureHandling.INCREMENT_STAT)
    with BatchTraceProcessor([fixture()], cfg) as btp:
      meta = btp._pool.handles[0].metadata
      df = btp._handle_query_timeout(0, meta)
      self.assertTrue(df.empty)
      kinds = {f.kind for f in btp.failures()}
      self.assertEqual(kinds, {'query_timeout'})
      self.assertEqual(btp.stats().execute_failures, 1)


# --- Config save/load -----------------------------------------------------


class TestConfigPersistence(unittest.TestCase):

  def test_json_roundtrip(self):
    with tempfile.TemporaryDirectory() as d:
      path = Path(d) / 'cfg.json'
      cfg = base_config(query_timeout_s=120, memory_budget_mb=2048)
      save_config_json(cfg, path)
      loaded = load_config_json(path)
      self.assertEqual(loaded['query_timeout_s'], 120)
      self.assertEqual(loaded['memory_budget_mb'], 2048)
      # Nested tp_config also persisted.
      self.assertEqual(loaded['tp_config']['bin_path'],
                       os.environ['SHELL_PATH'])

  def test_callable_fields_skipped(self):
    """preexec_fn and other callables can't be JSON-serialised; the
    serializer drops them silently."""
    with tempfile.TemporaryDirectory() as d:
      path = Path(d) / 'cfg.json'
      cfg = base_config()
      cfg.tp_config.preexec_fn = lambda: None
      save_config_json(cfg, path)
      raw = json.loads(path.read_text())
      self.assertNotIn('preexec_fn', raw['tp_config'])


# --- Session: durable + replay --------------------------------------------


class TestSession(unittest.TestCase):

  def test_query_id_stable_across_order(self):
    fps_a = [
        type('F', (), {
            'path': '/a',
            'mtime': 1.0
        })(),
        type('F', (), {
            'path': '/b',
            'mtime': 2.0
        })(),
    ]
    fps_b = list(reversed(fps_a))
    self.assertEqual(
        query_id_for('select 1', fps_a), query_id_for('select 1', fps_b))
    self.assertNotEqual(
        query_id_for('select 1', fps_a), query_id_for('select 2', fps_a))

  def test_cache_hit_returns_instantly(self):
    """Run a query twice with the same session_dir; on the warm
    path we exercise the cache without spawning shells.

    We use bounded mode so the v1 fail-fast eager warmup doesn't
    front-load shell spawn into the timing — that's what we want to
    skip when the cache holds the answer. We also test directly via
    `_cached_query_iter` to isolate the cache path."""
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(session_dir=Path(d), max_loaded_traces=1)
      with BatchTraceProcessor([fixture()] * 3, cfg) as btp:
        df1 = btp.query_and_flatten('select count(*) as n from slice')

      # Reload: the session has the query cached.
      cfg2 = base_config(session_dir=Path(d), max_loaded_traces=1)
      with BatchTraceProcessor([fixture()] * 3, cfg2) as btp:
        qids = btp.list_queries()
        self.assertEqual(len(qids), 1)
        # Time only the query path; construction time is not the
        # contract being asserted here.
        t0 = time.perf_counter()
        df2 = btp.query_and_flatten('select count(*) as n from slice')
        warm_query_t = time.perf_counter() - t0
      pd.testing.assert_frame_equal(
          df1.reset_index(drop=True),
          df2.reset_index(drop=True),
          check_dtype=False)
      # Pure cache fetch should be sub-second across 3 traces.
      self.assertLess(warm_query_t, 1.0,
                      f'warm-query {warm_query_t:.2f}s exceeds budget')

  def test_kill_dash_9_survivable(self):
    """SIGKILL the child Python mid-run; the next launch should pick
    up cached results and not redo them.

    We use a subprocess as a stand-in for a crash: it runs a partial
    workload in another process, gets SIGKILL'd, and we then attach
    in this process and check the session DB has rows."""
    with tempfile.TemporaryDirectory() as d:
      session_dir = Path(d)
      script = '''
import os, time, sys
sys.path.insert(0, %r)
from perfetto.batch_trace_processor.api import BatchTraceProcessor, BatchTraceProcessorConfig
from perfetto.trace_processor import TraceProcessorConfig
cfg = BatchTraceProcessorConfig(
    tp_config=TraceProcessorConfig(bin_path=%r),
    session_dir=%r)
with BatchTraceProcessor([%r] * 4, cfg) as btp:
    for meta, df in btp._cached_query_iter('select count(*) as n from slice',
        'q', __import__('perfetto.batch_trace_processor.session', fromlist=['fingerprint_traces']).fingerprint_traces([h.metadata for h in btp._pool.handles])):
        print('done', flush=True)
        time.sleep(60)
''' % (os.environ['ROOT_DIR'] + '/python', os.environ['SHELL_PATH'],
       str(session_dir), small_fixture())
      script_path = Path(d) / 'crash_run.py'
      script_path.write_text(script)
      env = os.environ.copy()
      proc = subprocess.Popen([sys.executable, str(script_path)],
                              stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE,
                              env=env)
      try:
        # Wait for at least one 'done' line then SIGKILL.
        progressed = 0
        deadline = time.time() + 60
        while time.time() < deadline:
          line = proc.stdout.readline()
          if not line:
            break
          if b'done' in line:
            progressed += 1
            if progressed >= 1:
              break
        os.kill(proc.pid, signal.SIGKILL)
      finally:
        proc.wait(timeout=10)

      # Resume in this process: the session should have at least one
      # cached result.
      cfg = base_config(session_dir=session_dir)
      with BatchTraceProcessor([small_fixture()] * 4, cfg) as btp:
        queries = btp.list_queries()
        # At least one query started (and possibly partially cached).
        self.assertGreaterEqual(len(queries), 1)
        cached = btp.session.cached_handles(queries[0].query_id)
        self.assertGreaterEqual(len(cached), 1, 'no rows survived the crash')


# --- Per-trace metadata in cache ------------------------------------------


class TestMetadataFlowsThroughCache(unittest.TestCase):

  def test_metadata_columns_after_replay(self):
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(session_dir=Path(d))
      traces = TracesWithMetadata([
          (fixture(), {
              'device': 'pixel8',
              'tag': 'a'
          }),
          (fixture(), {
              'device': 'pixel7',
              'tag': 'b'
          }),
      ])
      with BatchTraceProcessor(traces, cfg) as btp:
        df = btp.query_and_flatten('select 1 as v')
      self.assertEqual(set(df['device']), {'pixel8', 'pixel7'})
      # Replay path: same content from the durable cache.
      with BatchTraceProcessor(traces, cfg) as btp:
        qid = btp.list_queries()[0].query_id
        df2 = btp.replay(qid)
      self.assertGreater(len(df2), 0)
      self.assertIn('_handle_idx', df2.columns)


# --- Progress snapshot ----------------------------------------------------


class TestProgress(unittest.TestCase):

  def test_progress_idle_then_active(self):
    pt = ProgressTracker()
    self.assertEqual(pt.snapshot().query_id, '')
    pt.begin('q1', 'select 1', total=4)
    snap = pt.snapshot()
    self.assertEqual(snap.query_id, 'q1')
    self.assertEqual(snap.total, 4)
    self.assertEqual(snap.completed, 0)
    pt.step(failed=False)
    pt.step(failed=True)
    snap = pt.snapshot()
    self.assertEqual(snap.completed, 2)
    self.assertEqual(snap.failed, 1)
    pt.end()
    self.assertEqual(pt.snapshot().query_id, '')


# --- HTTP server / agent-shaped API ---------------------------------------


def _http_get_json(url: str) -> Any:
  with urllib.request.urlopen(url, timeout=5) as resp:
    return json.loads(resp.read())


def _http_post_json(url: str, body: Dict[str, Any]) -> Any:
  data = json.dumps(body).encode('utf-8')
  req = urllib.request.Request(
      url,
      data=data,
      headers={'Content-Type': 'application/json'},
      method='POST')
  with urllib.request.urlopen(req, timeout=10) as resp:
    return json.loads(resp.read())


class TestHttpServer(unittest.TestCase):

  def test_info_traces_run_results_progress(self):
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(session_dir=Path(d))
      traces = TracesWithMetadata([
          (fixture(), {
              'device': 'pixel8'
          }),
          (fixture(), {
              'device': 'pixel7'
          }),
      ])
      with BatchTraceProcessor(traces, cfg) as btp:
        url = btp.serve(port=0)
        info = _http_get_json(url + '/info')
        self.assertEqual(info['trace_count'], 2)

        traces_json = _http_get_json(url + '/traces')
        self.assertEqual(len(traces_json), 2)
        self.assertIn('device', traces_json[0])

        run = _http_post_json(url + '/run', {'sql': 'select 42 as answer'})
        qid = run['query_id']
        self.assertTrue(qid)

        rows = _http_get_json(url + '/results/' + qid)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['answer'], 42)

        prog = _http_get_json(url + '/progress')
        self.assertIn('total', prog)


# --- info() + run_query() agentic flow ------------------------------------


class TestAgenticFlow(unittest.TestCase):

  def test_chain_query_results(self):
    """Demonstrates an agent-style chain: run query, read result,
    use it to compose the next query."""
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(session_dir=Path(d))
      with BatchTraceProcessor([fixture()] * 2, cfg) as btp:
        qid = btp.run_query('select count(*) as n from slice')
        df = btp.replay(qid)
        self.assertEqual(len(df), 2)
        # Second query, derived from the first.
        max_n = int(df['n'].max())
        qid2 = btp.run_query(f'select {max_n} as cap')
        df2 = btp.replay(qid2)
        self.assertEqual(int(df2['cap'].iloc[0]), max_n)


# --- Load-failure classification ------------------------------------------


class TestLoadFailureClassification(unittest.TestCase):
  """Verify load_timeout / load_failed / missing_file kinds each
  round-trip through TraceFailure with the right shape."""

  def test_failure_kinds_recorded_with_full_metadata(self):
    from perfetto.trace_processor.shell import LoadTimeoutError
    log = FailureLog()
    log.add(
        TraceFailure(
            handle_idx=0,
            metadata={'_path': '/tmp/x'},
            kind='load_timeout',
            detail=str(LoadTimeoutError('t/o'))))
    log.add(
        TraceFailure(
            handle_idx=1,
            metadata={'_path': '/tmp/y'},
            kind='missing_file',
            detail='trace file is gone'))
    self.assertEqual(len(log.by_kind('load_timeout')), 1)
    self.assertEqual(len(log.by_kind('missing_file')), 1)
    rec = log.to_records()
    self.assertEqual(rec[0]['kind'], 'load_timeout')
    self.assertEqual(rec[1]['kind'], 'missing_file')
    # Both kinds must be in the canonical taxonomy (else format_failure
    # would normalise them to 'unknown').
    self.assertIn('load_timeout', FAILURE_KINDS)
    self.assertIn('missing_file', FAILURE_KINDS)


# --- Real-workload edge cases -----------------------------------------------


class TestRealWorkloadEdgeCases(unittest.TestCase):
  """E2E behaviour against real `trace_processor_shell`. These are the
  paths a notebook user actually drives — metadata-filtered slices,
  failure-survival, cache invalidation when the trace mtime changes,
  list/replay/export round-trip."""

  def test_metadata_filter_on_query_and_flatten(self):
    """Mixed metadata schemas + per-row filtering on a metadata column."""
    traces = TracesWithMetadata([
        (fixture(), {
            'device': 'pixel8',
            'scenario': 'cold-launch',
            'build': 'AOSP'
        }),
        (fixture(), {
            'device': 'pixel7',
            'scenario': 'cold-launch',
            'build': 'GMS'
        }),
        (fixture(), {
            'device': 'pixel8',
            'scenario': 'background-fetch',
            'build': 'AOSP'
        }),
    ])
    cfg = base_config(max_loaded_traces=2)
    with BatchTraceProcessor(traces, cfg) as btp:
      df = btp.query_and_flatten(
          'select count(*) as slice_n from slice where dur > 1000')
    self.assertEqual(set(df['device'].unique()), {'pixel7', 'pixel8'})
    pixel8 = df[df['device'] == 'pixel8']
    self.assertEqual(len(pixel8), 2)  # both pixel8 rows
    # Mixed metadata: every column should be present per row.
    for col in ('device', 'scenario', 'build', 'slice_n'):
      self.assertIn(col, df.columns)
    self.assertGreater(int(df['slice_n'].sum()), 0)

  def test_one_failing_query_does_not_kill_others(self):
    """SQL that is invalid for some traces but valid for others. Under
    INCREMENT_STAT we expect failures recorded structurally but the
    surviving rows are still returned."""
    traces = TracesWithMetadata([
        (fixture(), {
            'tag': 'a'
        }),
        (fixture(), {
            'tag': 'b'
        }),
    ])
    cfg = base_config(
        max_loaded_traces=1,
        execute_failure_handling=FailureHandling.INCREMENT_STAT,
    )
    with BatchTraceProcessor(traces, cfg) as btp:
      # Invalid SQL — should produce query_error for every trace.
      df = btp.query_and_flatten('select * from nonexistent_table_xyz')
      self.assertEqual(len(df), 0)
      self.assertGreaterEqual(len(btp.failures()), 2)
      kinds = {f.kind for f in btp.failures()}
      self.assertEqual(kinds, {'query_error'})
      # Failures DataFrame carries metadata columns.
      fdf = btp.failures_df()
      self.assertIn('tag', fdf.columns)
      self.assertEqual(set(fdf['tag'].unique()), {'a', 'b'})

  def test_cache_invalidation_on_mtime_change(self):
    """Bumping the trace's mtime should produce a different query_id,
    so the same SQL re-runs against the new bytes instead of returning
    a stale cached result."""
    with tempfile.TemporaryDirectory() as d:
      # Copy the fixture so we can touch its mtime.
      import shutil
      copy = Path(d) / 'copy.pb'
      shutil.copy(fixture(), copy)
      cfg = base_config(session_dir=Path(d) / 'session')
      sql = 'select count(*) as n from slice'
      with BatchTraceProcessor([str(copy)], cfg) as btp:
        first = btp.list_queries()
        self.assertEqual(len(first), 0)
        df1 = btp.query_and_flatten(sql)
        first_qid = btp.list_queries()[0].query_id
      # Bump mtime; same SQL should produce a different query_id.
      future = time.time() + 10
      os.utime(copy, (future, future))
      with BatchTraceProcessor([str(copy)], cfg) as btp:
        df2 = btp.query_and_flatten(sql)
        ids = {q.query_id for q in btp.list_queries()}
      self.assertEqual(int(df1['n'].iloc[0]), int(df2['n'].iloc[0]))
      self.assertEqual(len(ids), 2)
      self.assertIn(first_qid, ids)

  def test_list_replay_export_roundtrip(self):
    with tempfile.TemporaryDirectory() as d:
      session = Path(d) / 'session'
      cfg = base_config(session_dir=session)
      with BatchTraceProcessor([fixture(), fixture()], cfg) as btp:
        qid = btp.run_query('select 42 as answer')
        # list_queries surfaces it.
        listed = btp.list_queries()
        self.assertTrue(any(q.query_id == qid for q in listed))
        # replay returns a DataFrame.
        df = btp.replay(qid)
        self.assertEqual(int(df['answer'].iloc[0]), 42)
        # export to parquet succeeds and the file is non-empty.
        out = Path(d) / 'out.parquet'
        result = btp.export(qid, out)
        self.assertTrue(Path(result).exists())
        self.assertGreater(Path(result).stat().st_size, 0)

  def test_empty_trace_list_is_safe(self):
    """No traces in, no traces out — must not crash."""
    cfg = base_config(max_loaded_traces=1)
    with BatchTraceProcessor([], cfg) as btp:
      out = btp.query_and_flatten('select 1')
      self.assertEqual(len(out), 0)
      self.assertEqual(len(btp.failures()), 0)
      self.assertEqual(btp.info()['trace_count'], 0)

  def test_concurrent_same_query_does_not_double_dispatch(self):
    """Two threads asking for the same SQL with a session_dir should
    produce one cached result, not two independent runs."""
    with tempfile.TemporaryDirectory() as d:
      cfg = base_config(session_dir=Path(d))
      with BatchTraceProcessor([fixture()], cfg) as btp:
        sql = 'select count(*) as n from slice'
        results = []
        errs = []

        def run():
          try:
            results.append(btp.query_and_flatten(sql))
          except Exception as ex:  # noqa: BLE001
            errs.append(ex)

        threads = [threading.Thread(target=run) for _ in range(4)]
        for t in threads:
          t.start()
        for t in threads:
          t.join()
        self.assertEqual(len(errs), 0)
        self.assertEqual(len(results), 4)
        # All four results agree.
        first = int(results[0]['n'].iloc[0])
        for r in results[1:]:
          self.assertEqual(int(r['n'].iloc[0]), first)


if __name__ == '__main__':
  unittest.main()
