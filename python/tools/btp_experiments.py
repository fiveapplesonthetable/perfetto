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
"""Push the BTP through every cascade transition and time it.

Drives a running `btp_serve.py` HTTP endpoint and measures:

  cold       — first time a (sql, corpus) is run; full parse + query.
  warm       — same query again; SQLite session cache short-circuits
               every per-trace result, no shell touched.
  thaw       — re-query a trace whose handle was paused (cgroup.freeze).
               Should be near-instant: one cgroup.freeze=0 write +
               whatever the next query takes.
  reload     — re-query a trace whose handle was evicted (closed).
               Full re-parse from .perfetto-trace.
  reconfigure_during_query
             — fire a query in a thread; partway through, halve
               memory_budget_mb. Watch the pressure monitor adapt.

Each row is one experiment; each value is a wall-clock seconds
measurement. Output is one JSON record per row to stdout, plus a
markdown table at the end for human eyes.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional


def http_get(url: str) -> Any:
  with urllib.request.urlopen(url, timeout=30) as resp:
    return json.loads(resp.read())


def http_post(url: str, payload: Dict[str, Any]) -> Any:
  body = json.dumps(payload).encode()
  req = urllib.request.Request(
      url,
      data=body,
      method='POST',
      headers={'Content-Type': 'application/json'})
  with urllib.request.urlopen(req, timeout=600) as resp:
    return json.loads(resp.read())


def info(base: str) -> Dict[str, Any]:
  return http_get(f'{base}/info')


def run_query(base: str, sql: str) -> Dict[str, Any]:
  """Time a /run + /results round trip end-to-end."""
  t0 = time.time()
  r = http_post(f'{base}/run', {'sql': sql})
  qid = r['query_id']
  rows = http_get(f'{base}/results/{qid}')
  return {
      'sql': sql,
      'query_id': qid,
      'wall_s': round(time.time() - t0, 3),
      'rows': len(rows),
  }


def reconfigure(base: str, **partial: Any) -> Dict[str, Any]:
  return http_post(f'{base}/config', partial)


def measure_cold_warm(base: str, sql: str) -> Dict[str, float]:
  """Cold = first time we run this exact SQL; warm = identical replay
  served from the SQLite session cache."""
  cold = run_query(base, sql)
  warm = run_query(base, sql)
  return {
      'cold_wall_s': cold['wall_s'],
      'warm_wall_s': warm['wall_s'],
      'speedup': round(cold['wall_s'] / max(warm['wall_s'], 0.001), 1),
  }


def measure_reconfigure_during_query(base: str, sql: str,
                                     new_memory_mb: int) -> Dict[str, Any]:
  """Fire a heavy query in a thread; partway through, drop memory
  budget so the pressure monitor must close handles. Verify the
  query still completes and that freeze/evict counters climbed.
  Restores the original budget on exit."""
  before = info(base)
  original_budget = before.get('memory_budget_mb')
  before_freezes = before.get('total_freeze_evictions', 0)
  before_reloads = before.get('total_reloads', 0)
  before_evicted = before.get('evicted', 0)

  result_holder: Dict[str, Any] = {}

  def fire():
    try:
      r = run_query(base, sql)
      result_holder['result'] = r
    except Exception as ex:  # noqa: BLE001
      result_holder['error'] = str(ex)

  t = threading.Thread(target=fire, daemon=True)
  t.start()
  try:
    # Mid-query: drop memory budget. Pressure monitor should react.
    time.sleep(2.0)
    reconfigure(base, memory_budget_mb=new_memory_mb)
    reconfig_ts = time.time()
    t.join(timeout=600)
    after = info(base)
  finally:
    if original_budget is not None:
      try:
        reconfigure(base, memory_budget_mb=int(original_budget))
        time.sleep(0.5)
      except Exception:  # noqa: BLE001
        pass
  return {
      'completed': 'result' in result_holder,
      'error': result_holder.get('error'),
      'wall_s': result_holder.get('result', {}).get('wall_s'),
      'rows': result_holder.get('result', {}).get('rows'),
      'reconfig_at_t_s': round(time.time() - reconfig_ts, 3),
      'freezes_added':
          (after.get('total_freeze_evictions', 0) - before_freezes),
      'reloads_added': (after.get('total_reloads', 0) - before_reloads),
      'evicted_delta': after.get('evicted', 0) - before_evicted,
      'final_memory_used_mb': after.get('memory_used_mb'),
  }


def find_one_tp_shell_pid() -> Optional[int]:
  """Return the PID of any running trace_processor_shell on the host."""
  try:
    out = subprocess.check_output(['pgrep', '-f', 'trace_processor_shell'],
                                  text=True)
  except subprocess.CalledProcessError:
    return None
  pids = [int(x) for x in out.split() if x.strip()]
  return pids[0] if pids else None


def measure_kill_and_resurrect(base: str, sql: str) -> Dict[str, Any]:
  """SIGKILL a worker shell, fire a query, confirm reload counter climbs
  and the result still completes (the framework respawns the dead shell
  on the next acquire)."""
  before = info(base)
  before_reloads = before.get('total_reloads', 0)
  pid = find_one_tp_shell_pid()
  if pid is None:
    return {'skipped': 'no trace_processor_shell running'}
  try:
    os.kill(pid, signal.SIGKILL)
  except ProcessLookupError:
    pass
  killed_at = time.time()
  # Give the framework a moment to notice the dead pipe.
  time.sleep(0.3)
  q = run_query(base, sql)
  after = info(base)
  return {
      'killed_pid': pid,
      'wall_s_after_kill': q['wall_s'],
      'rows': q['rows'],
      'reloads_added': after.get('total_reloads', 0) - before_reloads,
      'time_to_first_query_s': round(time.time() - killed_at, 3),
      'final_loaded': after.get('loaded'),
      'final_evicted': after.get('evicted'),
  }


def measure_thaw_and_reload(base: str, sql_a: str, sql_b: str,
                            tighten_mb: int) -> Dict[str, Any]:
  """Force the pool through (loaded -> frozen -> evicted) by tightening
  the memory budget mid-test, then reload via a fresh query. Restores
  the original budget on exit so downstream experiments aren't squeezed
  out by the same kernel OOM."""
  before = info(base)
  original_budget = before.get('memory_budget_mb')
  baseline_freezes = before.get('total_freeze_evictions', 0)
  baseline_reloads = before.get('total_reloads', 0)
  try:
    # Step 1: query A — populates loaded handles.
    q1 = run_query(base, sql_a)
    step1 = info(base)
    # Step 2: drop memory budget aggressively → monitor should freeze
    # handles, then evict if no swap.
    reconfigure(base, memory_budget_mb=tighten_mb)
    time.sleep(3.0)  # let monitor act for a few ticks
    step2 = info(base)
    # Step 3: query B (fresh SQL — guaranteed cache miss). This forces
    # acquires on traces that may now be frozen or evicted; we should
    # see thaw + reload counts grow.
    q2 = run_query(base, sql_b)
    step3 = info(base)
  finally:
    if original_budget is not None:
      try:
        reconfigure(base, memory_budget_mb=int(original_budget))
        time.sleep(0.5)
      except Exception:  # noqa: BLE001
        pass
  return {
      'q1_cold_wall_s':
          q1['wall_s'],
      'q2_after_tighten_wall_s':
          q2['wall_s'],
      'freezes_during_tighten':
          (step2['total_freeze_evictions'] - step1['total_freeze_evictions']),
      'reloads_during_q2':
          step3['total_reloads'] - step2.get('total_reloads', 0),
      'final_loaded':
          step3['loaded'],
      'final_frozen':
          step3['frozen'],
      'final_evicted':
          step3['evicted'],
      'memory_used_mb_peak':
          max(step1['memory_used_mb'], step2['memory_used_mb'],
              step3['memory_used_mb']),
      'budget_freezes_total':
          step3['total_freeze_evictions'] - baseline_freezes,
      'budget_reloads_total':
          step3['total_reloads'] - baseline_reloads,
  }


def main() -> int:
  ap = argparse.ArgumentParser(
      description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument(
      '--url',
      default='http://127.0.0.1:8080',
      help='URL of a running btp_serve.py instance.')
  ap.add_argument(
      '--cold-warm-sql',
      default=None,
      help='SQL for the cold/warm cache experiment. Auto-generated '
      'with a randomizer suffix to guarantee a cache miss the '
      'first time.')
  ap.add_argument(
      '--reconfig-tight-mb',
      type=int,
      default=2048,
      help='Memory budget to drop to mid-query in the reconfigure '
      'experiment. Default 2048.')
  ap.add_argument(
      '--reload-tight-mb',
      type=int,
      default=3072,
      help='Memory budget to drop to in the thaw/reload experiment. '
      'Default 3072 — enough to force freezes without OOM-killing '
      'the spawn path.')
  args = ap.parse_args()

  base = args.url.rstrip('/')
  start = info(base)
  print(json.dumps({'event': 'experiment_start', 'info': start}), flush=True)

  rand_a = int(time.time())
  rand_b = rand_a + 1
  sql_cold = (
      args.cold_warm_sql or
      f'select count(*) as n from slice where dur > {rand_a}')
  sql_thaw_b = f'select count(*) as n from slice where dur > {rand_b}'

  results: List[Dict[str, Any]] = []

  def safe(name: str, fn):
    try:
      row = {'experiment': name, **fn()}
    except Exception as ex:  # noqa: BLE001
      row = {'experiment': name, 'error': str(ex)[:200]}
    print(json.dumps(row), flush=True)
    results.append(row)

  # --- cold vs warm cache --------------------------------------------------
  safe('cold_vs_warm', lambda: measure_cold_warm(base, sql_cold))

  # --- mid-query reconfigure (memory budget) -------------------------------
  safe(
      'reconfigure_during_query', lambda: measure_reconfigure_during_query(
          base, f'select count(*) as n from slice where ts > {rand_a + 100}',
          args.reconfig_tight_mb))

  # --- thaw + reload under tight budget -----------------------------------
  safe(
      'thaw_and_reload_under_pressure', lambda: measure_thaw_and_reload(
          base, f'select count(*) as n from slice where ts > {rand_a + 200}',
          sql_thaw_b, args.reload_tight_mb))

  # --- kill a TP shell, verify the framework respawns ---------------------
  safe(
      'kill_and_resurrect', lambda: measure_kill_and_resurrect(
          base, f'select count(*) as n from slice where ts > {rand_a + 300}'))

  # --- summary table ------------------------------------------------------
  print('\n## Results\n', flush=True)
  print('| experiment | key metrics |', flush=True)
  print('|---|---|', flush=True)
  for r in results:
    metrics = ' / '.join(f'{k}={v}' for k, v in r.items() if k != 'experiment')
    print(f"| {r['experiment']} | {metrics} |", flush=True)
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
