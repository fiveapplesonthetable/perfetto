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
"""Progress + status — easy to inspect by humans and agents.

`Progress` is a snapshot the caller can poll at any time; the design
mirrors what tqdm shows but stays as plain data so an agent can
`btp.progress()` and reason about it programmatically:

    p = btp.progress()
    if p.completed < p.total and p.eta_s > 30:
        print(f"~{p.eta_s:.0f}s remaining ({p.completed}/{p.total})")

`ProgressTracker` is the side that updates this from the executing
threads. Lock-free reads (atomic ints + a single time stamp).
"""

from __future__ import annotations

import dataclasses as dc
import threading
import time
from typing import Optional


@dc.dataclass(frozen=True)
class Progress:
  """Immutable snapshot of in-flight execution.

  Attributes:
    query_id: opaque identifier of the query in flight ('' if idle).
    sql: the SQL being executed (truncated to 200 chars for sanity).
    total: total trace count for this query.
    completed: traces finished (success or failure).
    failed: subset of `completed` that ended in a failure.
    started_ts: when the query started (unix seconds).
    eta_s: estimated remaining wallclock; 0.0 if idle or
      unavailable.
  """
  query_id: str = ''
  sql: str = ''
  total: int = 0
  completed: int = 0
  failed: int = 0
  started_ts: float = 0.0
  eta_s: float = 0.0

  @property
  def fraction(self) -> float:
    return 0.0 if self.total <= 0 else self.completed / self.total

  def to_dict(self) -> dict:
    return dc.asdict(self)


class ProgressTracker:
  """Mutable counter set; emit a Progress snapshot on demand.

  Thread-safe. The main caller is `BatchTraceProcessor`, but the
  HTTP server also reads from this so an agent or UI can poll
  status without blocking the executor."""

  _SQL_PREVIEW_LEN = 200

  def __init__(self) -> None:
    self._lock = threading.Lock()
    self._query_id = ''
    self._sql = ''
    self._total = 0
    self._completed = 0
    self._failed = 0
    self._started_ts = 0.0

  def begin(self, query_id: str, sql: str, total: int) -> None:
    with self._lock:
      self._query_id = query_id
      self._sql = sql[:self._SQL_PREVIEW_LEN]
      self._total = max(0, int(total))
      self._completed = 0
      self._failed = 0
      self._started_ts = time.time()

  def step(self, *, failed: bool) -> None:
    with self._lock:
      self._completed += 1
      if failed:
        self._failed += 1

  def end(self) -> None:
    with self._lock:
      # Snapshot ends but final counters remain readable.
      self._query_id = ''

  def snapshot(self) -> Progress:
    with self._lock:
      total = self._total
      done = self._completed
      started = self._started_ts
      eta = 0.0
      if started > 0 and done > 0 and done < total:
        elapsed = max(0.0, time.time() - started)
        per_item = elapsed / done
        eta = per_item * (total - done)
      return Progress(
          query_id=self._query_id,
          sql=self._sql,
          total=total,
          completed=done,
          failed=self._failed,
          started_ts=started,
          eta_s=eta,
      )
