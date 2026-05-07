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
"""Structured per-trace failure record + log.

Anything that takes a single trace out of the working set surfaces here:
load timeouts, OOM kills, query timeouts, parse errors, mid-query crashes,
RLIMIT trips. Callers can introspect via `BatchTraceProcessor.failures()`,
`failures_df()`, or `print_failures()`.
"""

from __future__ import annotations

import dataclasses as dc
import threading
import time
from typing import Dict, List, Optional

# Failure kind tags. Plain strings rather than Enum so that pandas
# filtering reads naturally:
#     failures_df[failures_df['kind'] == 'oom_killed']
FAILURE_KINDS = (
    'load_timeout',  # parse exceeded load_timeout_s
    'load_failed',  # parse raised before completing
    'missing_file',  # `_path` does not exist on disk (transient)
    'tp_crash',  # subprocess died; HTTP got ConnectionError
    'query_timeout',  # query exceeded query_timeout_s
    'query_error',  # SQL error from the shell (TraceProcessorException)
    'unknown',
)


@dc.dataclass
class TraceFailure:
  """One per-trace failure event."""
  handle_idx: int
  metadata: Dict[str, str]
  kind: str
  detail: str
  when: float = dc.field(default_factory=time.time)
  exit_code: Optional[int] = None
  stderr_tail: Optional[str] = None  # last ~4 KB of stderr if available

  def __post_init__(self) -> None:
    if self.kind not in FAILURE_KINDS:
      # Don't reject — we always want to record. Normalize so consumers
      # can rely on the tag set.
      self.detail = f'[unrecognized kind={self.kind}] {self.detail}'
      self.kind = 'unknown'


class FailureLog:
  """Thread-safe accumulator. The contract is "always log, never lose".
  Adds are O(1); reads return a snapshot (caller can iterate freely)."""

  def __init__(self) -> None:
    self._lock = threading.Lock()
    self._entries: List[TraceFailure] = []

  def add(self, failure: TraceFailure) -> None:
    with self._lock:
      self._entries.append(failure)

  def all(self) -> List[TraceFailure]:
    with self._lock:
      return list(self._entries)

  def __len__(self) -> int:
    with self._lock:
      return len(self._entries)

  def by_kind(self, kind: str) -> List[TraceFailure]:
    with self._lock:
      return [f for f in self._entries if f.kind == kind]

  def count_by_kind(self) -> Dict[str, int]:
    """Tally of failures bucketed by `kind`. Empty kinds are omitted
    so the status UI can render only the kinds that have actually
    been observed."""
    counts: Dict[str, int] = {}
    with self._lock:
      for f in self._entries:
        counts[f.kind] = counts.get(f.kind, 0) + 1
    return counts

  def to_records(self) -> List[Dict[str, object]]:
    """List of plain dicts; pandas-friendly. Metadata is flattened so
    a column-per-key approach reads naturally."""
    with self._lock:
      out: List[Dict[str, object]] = []
      for f in self._entries:
        rec: Dict[str, object] = {
            'handle_idx': f.handle_idx,
            'kind': f.kind,
            'detail': f.detail,
            'when': f.when,
            'exit_code': f.exit_code,
        }
        for k, v in (f.metadata or {}).items():
          rec.setdefault(k, v)
        rec['stderr_tail'] = f.stderr_tail
        out.append(rec)
      return out


def format_failure(f: TraceFailure) -> str:
  """One-line human-readable rendering, used by `print_failures`."""
  ts = time.strftime('%H:%M:%S', time.localtime(f.when))
  src = f.metadata.get('_path') or f.metadata.get('source') or '<unknown>'
  prefix = f'[{ts}] idx={f.handle_idx:<5} kind={f.kind:<14} {src}'
  detail = f.detail
  if f.exit_code is not None:
    detail = f'{detail} (exit={f.exit_code})'
  return f'{prefix} :: {detail}'
