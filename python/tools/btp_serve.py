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
"""Run a BatchTraceProcessor as an HTTP server.

The same `btp.serve(...)` surface that the Bigtrace UI (`/btp`) and
the agentic API call. Useful when you don't want to write a Python
script — point it at a directory of traces (or a glob, or a JSON
manifest) and it stays up until you Ctrl-C.

QUICK START

    # Simplest: a directory of traces.
    SHELL_PATH=$PWD/out/linux/trace_processor_shell \\
    python3 python/tools/btp_serve.py /path/to/traces

    # Same, but also watch the dir for new traces (e.g. uploads still
    # arriving from a recording rig). Best-effort: queries run against
    # whatever's already loaded; new files fold in as they appear.
    python3 python/tools/btp_serve.py /path/to/traces --watch

    # Full corpus declared up front via JSON; files trickle in.
    python3 python/tools/btp_serve.py --traces-json corpus.json --watch

    # Glob (repeatable) — for one-off ad-hoc analysis.
    python3 python/tools/btp_serve.py --trace 'runs/*.pftrace' \\
        --trace 'baselines/*.pftrace'

DEFAULT BUDGETS (half of machine)

    cpu_workers       = half of usable cores
    memory_budget_mb  = half of MemAvailable

Leaves headroom for the analyst's other tools (notebooks, browser,
IDE). Override with --cpu-workers / --memory-mb. Also editable live
from /btp in the UI.

METADATA

Two ways to attach metadata to traces (device, scenario, build, ...):

  1. --traces-json: the manifest IS the corpus. Each row is
     `[path, {meta}]`. Files referenced but not yet on disk are best-
     effort: BTP queries whatever has arrived.

         [
           ["traces/pixel8-cold-1.pftrace", {"device": "pixel8",
                                              "scenario": "cold"}],
           ["traces/pixel7-cold-1.pftrace", {"device": "pixel7",
                                              "scenario": "cold"}]
         ]

  2. --metadata-json + --dir/--trace: the dir/glob enumerates the
     paths, the metadata file maps path-glob -> meta. First match
     wins. Useful when a recording pipeline produces files in a
     conventional layout.

         {
           "*pixel8*": {"device": "pixel8"},
           "*pixel7*": {"device": "pixel7"},
           "*cold-*": {"scenario": "cold"},
           "*warm-*": {"scenario": "warm"}
         }

AGENT-FRIENDLY OUTPUT

Startup prints a single JSON line tagged `btp_serve_ready` with the
URL, resolved budgets, and the metadata mapping. An agent can grep
for that line to extract the URL without parsing the human log.

After ready, all control-plane actions go through the HTTP API. The
endpoints relevant to agents:

    POST {url}/run           {"sql": "..."} -> {"query_id": "..."}
    GET  {url}/results/{qid}  -> [{...row...}, ...]
    GET  {url}/info           -> realtime pool state + budgets
    GET  {url}/traces         -> registered traces
    POST {url}/traces         {"path", "metadata"?} -> handle_idx
    POST {url}/config         {budget triple} -> echoes new config
"""

from __future__ import annotations

import argparse
import fnmatch
import glob
import json
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'python'))

from perfetto.batch_trace_processor import (
    BatchTraceProcessor,
    BatchTraceProcessorConfig,
)
from perfetto.batch_trace_processor.defaults import (
    auto_cpu_workers,
    auto_memory_budget_mb,
    total_machine_cores,
    total_machine_memory_mb,
)
from perfetto.batch_trace_processor.inputs import TracesWithMetadata
from perfetto.trace_processor import TraceProcessorConfig

# File extensions we recognise as traces in --dir mode. Keep this list
# permissive — the trace_processor_shell does its own sniffing, we
# just need to avoid wandering into unrelated files.
TRACE_EXTS = (
    '.perfetto-trace',
    '.pftrace',
    '.pb',
    '.atr',
    '.proto',
    '.systrace',
    '.json',
    '.gz',
)

# In-flight writes (e.g. `perfetto -o foo.perfetto-trace.tmp`, atomic
# renames staged via `.partial`/`.crdownload`/dotfiles). Skip until the
# writer renames to the final extension so we don't try to parse a
# truncated trace.
INFLIGHT_SUFFIXES = ('.tmp', '.partial', '.crdownload', '.download')


def _is_inflight(path: str) -> bool:
  base = os.path.basename(path)
  if base.startswith('.'):
    return True
  if any(base.endswith(suf) for suf in INFLIGHT_SUFFIXES):
    return True
  # Substring check for `*.tmp.*` patterns (`foo.perfetto-trace.tmp.42`).
  if any(f'{suf}.' in base or base.endswith(suf) for suf in INFLIGHT_SUFFIXES):
    return True
  return False


def _sniff_dir(directory: Path) -> List[str]:
  """Recursively gather trace paths from `directory`. In-flight writes
  (`*.tmp`, `*.partial`, dotfiles) are skipped so the trace processor
  never opens a half-written file."""
  out: List[str] = []
  for root, _dirs, files in os.walk(directory):
    for f in files:
      if _is_inflight(f):
        continue
      if any(f.endswith(ext) for ext in TRACE_EXTS):
        out.append(os.path.join(root, f))
  out.sort()
  return out


def _apply_metadata_map(path: str,
                        meta_map: Dict[str, Dict[str, str]]) -> Dict[str, str]:
  """Apply every globbing rule whose pattern matches the path; later
  matches override earlier (so users can layer broad -> specific)."""
  meta: Dict[str, str] = {}
  base = os.path.basename(path)
  for pattern, kvs in meta_map.items():
    if fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(base, pattern):
      meta.update({str(k): str(v) for k, v in kvs.items()})
  return meta


def _resolve_traces(
    args: argparse.Namespace,
    meta_map: Dict[str, Dict[str, str]]) -> List[Tuple[str, Dict[str, str]]]:
  """Build the initial corpus list from any combination of the input
  flags, layering --metadata-json over --dir / --trace results."""
  pairs: List[Tuple[str, Dict[str, str]]] = []
  seen: set = set()

  def _add(path: str, meta: Dict[str, str]) -> None:
    # `abspath` does NOT resolve symlinks — two symlinks to the same
    # target stay distinct corpus entries, which is what an analyst
    # who deliberately built a symlink farm expects.
    apath = os.path.abspath(path)
    if apath in seen:
      return
    seen.add(apath)
    pairs.append((apath, meta))

  # 1. Explicit JSON manifest first — this is the authoritative
  #    "expected corpus" surface for streaming workloads.
  if args.traces_json:
    blob = json.loads(Path(args.traces_json).read_text())
    if not isinstance(blob, list):
      raise SystemExit('--traces-json must contain a JSON array of '
                       '[path, {meta}] pairs')
    for item in blob:
      if (not isinstance(item, list) or len(item) != 2 or
          not isinstance(item[0], str) or not isinstance(item[1], dict)):
        raise SystemExit('--traces-json items must be [path, {meta}] pairs')
      _add(item[0], {str(k): str(v) for k, v in item[1].items()})

  # 2. Positional dir argument(s) — sniff for trace files.
  for d in (args.dirs or []):
    base = Path(d)
    if not base.exists():
      print(
          f'btp_serve: warning: --dir {d!r} does not exist (yet); '
          'will pick up files when --watch is set.',
          file=sys.stderr)
      continue
    if base.is_file():
      _add(str(base), _apply_metadata_map(str(base), meta_map))
      continue
    for p in _sniff_dir(base):
      _add(p, _apply_metadata_map(p, meta_map))

  # 3. Glob patterns.
  for pattern in (args.trace or []):
    matches = sorted(glob.glob(pattern))
    if not matches:
      print(
          f'btp_serve: warning: --trace {pattern!r} matched no files',
          file=sys.stderr)
    for path in matches:
      if _is_inflight(path):
        continue
      _add(path, _apply_metadata_map(path, meta_map))

  return pairs


class _Watcher:
  """Best-effort directory watcher. Polls every `interval_s` seconds,
  registers any newly-arrived files via `btp.add_trace(...)`. Cheap —
  one stat per known file per tick. Designed to be run in a daemon
  thread."""

  def __init__(self,
               btp: BatchTraceProcessor,
               dirs: List[str],
               globs: List[str],
               meta_map: Dict[str, Dict[str, str]],
               declared_paths: Dict[str, Dict[str, str]],
               interval_s: float = 5.0) -> None:
    self.btp = btp
    self.dirs = [Path(d) for d in dirs]
    self.globs = list(globs)
    self.meta_map = meta_map
    # Declared (but not-yet-resolved) paths from --traces-json. We
    # poll their existence on every tick so a network upload that
    # eventually lands is folded in seamlessly.
    self.declared = dict(declared_paths)
    self.known: set = set(
        h.metadata.get('_path', '') for h in btp._pool.handles  # noqa: SLF001
    )
    self.interval_s = interval_s
    self._stop = threading.Event()

  def stop(self) -> None:
    self._stop.set()

  def _candidates(self) -> List[Tuple[str, Dict[str, str]]]:
    found: List[Tuple[str, Dict[str, str]]] = []
    # Declared paths from the manifest take their declared metadata.
    for path, meta in self.declared.items():
      apath = str(Path(path).resolve())
      if apath in self.known:
        continue
      if Path(apath).exists():
        found.append((apath, dict(meta)))
    for d in self.dirs:
      if not d.exists():
        continue
      for p in _sniff_dir(d):
        apath = str(Path(p).resolve())
        if apath in self.known:
          continue
        found.append((apath, _apply_metadata_map(p, self.meta_map)))
    for pattern in self.globs:
      for p in glob.glob(pattern):
        if _is_inflight(p):
          continue
        apath = str(Path(p).resolve())
        if apath in self.known:
          continue
        found.append((apath, _apply_metadata_map(p, self.meta_map)))
    return found

  def run(self) -> None:
    while not self._stop.is_set():
      try:
        cands = self._candidates()
      except Exception as e:  # noqa: BLE001
        log.warning('btp_serve: watcher error: %s', e)
        cands = []
      added = 0
      for path, meta in cands:
        try:
          self.btp.add_trace(path, meta)
          self.known.add(path)
          added += 1
        except Exception as e:  # noqa: BLE001
          log.warning('btp_serve: add_trace(%s) failed: %s', path, e)
      if added:
        print(
            f'btp_serve: watcher registered {added} new trace(s) '
            f'(total now {len(self.known)})',
            flush=True)
      self._stop.wait(self.interval_s)


def main() -> int:
  global log
  logging.basicConfig(level=logging.INFO, format='%(message)s')
  log = logging.getLogger('btp_serve')

  ap = argparse.ArgumentParser(
      formatter_class=argparse.RawDescriptionHelpFormatter, description=__doc__)

  # Trace inputs (any combination).
  ap.add_argument(
      'dirs',
      nargs='*',
      metavar='DIR',
      help='Director(ies) of trace files. Recursively scanned for '
      '.perfetto-trace / .pftrace / .pb / .atr (and a few more). '
      'Repeatable.')
  ap.add_argument(
      '--trace',
      action='append',
      help='Glob pattern of trace files. Repeatable.')
  ap.add_argument(
      '--traces-json',
      help='JSON manifest: list of [path, {meta}] pairs. The manifest '
      'is authoritative — files not on disk yet stay declared and '
      'are picked up when --watch is set and they arrive.')
  ap.add_argument(
      '--metadata-json',
      help='JSON object mapping path-glob -> {meta_key: value}. First '
      'match wins; later globs in the dict layer over earlier. '
      'Used together with --dir / --trace.')
  ap.add_argument(
      '--watch',
      action='store_true',
      help='Poll the input dir(s) and globs every --watch-interval-s '
      'seconds, folding in newly-arrived files. Best-effort: '
      "queries run against whatever's currently registered; "
      'missing declared files just don\'t contribute (yet).')
  ap.add_argument(
      '--watch-interval-s',
      type=float,
      default=5.0,
      help='Poll period for --watch in seconds. Default 5.')

  # Engine.
  ap.add_argument(
      '--shell-path',
      default=os.environ.get('SHELL_PATH'),
      help='Path to trace_processor_shell. Defaults to $SHELL_PATH.')
  ap.add_argument('--host', default='127.0.0.1')
  ap.add_argument('--port', type=int, default=8080)
  ap.add_argument(
      '--session-dir',
      help='Directory for the durable SQLite cache (kill -9 survivable; '
      'instant warm reruns). Optional — without it the BTP is '
      'stateless across restarts.')

  # Budget triple. Every default is half of machine resources.
  ap.add_argument(
      '--cpu-workers',
      type=int,
      default=None,
      metavar='N',
      help=f'Query parallelism. Default: {auto_cpu_workers()} '
      f'(half of {total_machine_cores()} cores).')
  ap.add_argument(
      '--memory-mb',
      type=int,
      default=None,
      dest='memory_mb',
      metavar='MB',
      help=f'In-memory working set cap, MB. '
      f'Default: {auto_memory_budget_mb()} (half of '
      f'{total_machine_memory_mb()} MB).')
  ap.add_argument(
      '--query-timeout-s',
      type=float,
      default=15 * 60,
      help='Per-query timeout in seconds. Default 900.')

  args = ap.parse_args()

  if not args.shell_path:
    raise SystemExit('pass --shell-path or set $SHELL_PATH to a built '
                     'trace_processor_shell binary')
  if not Path(args.shell_path).exists():
    raise SystemExit(f'shell-path does not exist: {args.shell_path}')

  meta_map: Dict[str, Dict[str, str]] = {}
  if args.metadata_json:
    raw = json.loads(Path(args.metadata_json).read_text())
    if not isinstance(raw, dict):
      raise SystemExit('--metadata-json must be a JSON object '
                       '{glob: {key: value}}')
    for k, v in raw.items():
      if not isinstance(v, dict):
        raise SystemExit(f'--metadata-json values must be objects; '
                         f'got {type(v).__name__} for {k!r}')
      meta_map[str(k)] = {str(kk): str(vv) for kk, vv in v.items()}

  declared: Dict[str, Dict[str, str]] = {}
  if args.traces_json:
    blob = json.loads(Path(args.traces_json).read_text())
    if isinstance(blob, list):
      for item in blob:
        if (isinstance(item, list) and len(item) == 2 and
            isinstance(item[0], str) and isinstance(item[1], dict)):
          declared[str(Path(item[0]).resolve())] = {
              str(k): str(v) for k, v in item[1].items()
          }

  pairs = _resolve_traces(args, meta_map)
  # Filter to files that actually exist *now*. The watcher (if enabled)
  # picks up the rest when they arrive.
  resolved_now: List[Tuple[str, Dict[str, str]]] = []
  pending_now: List[str] = []
  for path, meta in pairs:
    if Path(path).exists():
      resolved_now.append((path, meta))
    else:
      pending_now.append(path)

  if not resolved_now and not args.watch:
    raise SystemExit(
        'no traces found — pass DIR / --trace <glob> / --traces-json, '
        'or use --watch to wait for files to arrive')

  if not resolved_now:
    print(
        'btp_serve: 0 traces resolved; --watch is set, server will '
        'come up empty and pick up files as they arrive.',
        file=sys.stderr,
        flush=True)

  cfg = BatchTraceProcessorConfig(
      tp_config=TraceProcessorConfig(bin_path=args.shell_path),
      memory_budget_mb=args.memory_mb,
      query_workers=args.cpu_workers,
      query_timeout_s=args.query_timeout_s,
      session_dir=Path(args.session_dir) if args.session_dir else None,
  )

  if resolved_now:
    print(
        f'btp_serve: building BTP with {len(resolved_now)} trace(s)…',
        flush=True)
    inputs = TracesWithMetadata(resolved_now)
  else:
    # Empty initial corpus. We still need a TracesWithMetadata so the
    # registry plumbing is consistent; pass an empty list. The watcher
    # will fold files in via add_trace once they exist.
    inputs = TracesWithMetadata([])

  btp = BatchTraceProcessor(inputs, cfg)
  url = btp.serve(host=args.host, port=args.port)
  info = btp.info()

  # Resolved budgets — what the user actually got after defaults.
  resolved_budgets = {
      'cpu_workers': info['cpu_workers'],
      'memory_budget_mb': info['memory_budget_mb'],
      'query_timeout_s': info['query_timeout_s'],
      'max_loaded': info['max_loaded'],
      'pool_mode': info['pool_mode'],
  }

  ready_payload = {
      'event': 'btp_serve_ready',
      'url': url,
      'trace_count': info['trace_count'],
      'pending_count': len(pending_now),
      'resolved_budgets': resolved_budgets,
      'metadata_map_globs': sorted(meta_map.keys()),
      'session_dir': info['session_dir'],
      'watch': bool(args.watch),
      'machine': {
          'cores': info['machine_cores_total'],
          'memory_mb': info['machine_memory_mb_total'],
      },
  }
  print(json.dumps(ready_payload), flush=True)
  print(f'btp_serve: ready at {url}', flush=True)
  print(
      f'  budgets cpu_workers={resolved_budgets["cpu_workers"]} '
      f'memory_mb={resolved_budgets["memory_budget_mb"]} '
      f'query_timeout_s={resolved_budgets["query_timeout_s"]}',
      flush=True)
  print(
      f'  trace_count={info["trace_count"]} '
      f'pool_mode={info["pool_mode"]} '
      f'max_loaded={info["max_loaded"]}',
      flush=True)
  if cfg.session_dir is not None:
    print(
        f'  session_dir={cfg.session_dir} '
        '(kill -9 survivable; warm reruns from cache)',
        flush=True)
  if args.watch:
    print(
        f'  --watch poll every {args.watch_interval_s}s '
        f'(dirs={len(args.dirs)} globs={len(args.trace or [])} '
        f'declared_pending={len(pending_now)})',
        flush=True)
  print('  Ctrl-C to stop.', flush=True)

  watcher: Optional[_Watcher] = None
  watcher_thread: Optional[threading.Thread] = None
  if args.watch:
    watcher = _Watcher(
        btp,
        dirs=list(args.dirs or []),
        globs=list(args.trace or []),
        meta_map=meta_map,
        declared_paths=declared,
        interval_s=args.watch_interval_s,
    )
    watcher_thread = threading.Thread(
        target=watcher.run, name='btp-watcher', daemon=True)
    watcher_thread.start()

  # Block until SIGINT/SIGTERM. signal.pause() is genuinely idle —
  # nothing wakes us but a signal.
  def _handler(signum, _frame):  # noqa: ANN001
    print(f'btp_serve: caught {signum}; closing…', flush=True)

  signal.signal(signal.SIGINT, _handler)
  signal.signal(signal.SIGTERM, _handler)
  try:
    signal.pause()
  except (InterruptedError, KeyboardInterrupt):
    pass
  finally:
    if watcher is not None:
      watcher.stop()
    btp.close()
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
