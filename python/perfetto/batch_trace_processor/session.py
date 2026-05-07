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
"""Durable session — stdlib `sqlite3` at `session_dir/btp.sqlite`.

Concept
-------

A `Session` is a "lab notebook" for one corpus. Two big benefits:

  1. Crash recovery. If the BTP process is `kill -9`'d mid-run, the
     next launch with the same `session_dir` reattaches the DB and
     surfaces what's already cached, what was partial, and what
     failed. No work is lost.

  2. Query memoization. Every `(sql, traces fingerprint)` produces a
     stable `query_id`. On a repeat call we skip the shell entirely
     and stream rows back from the DB.

Why SQLite (and not DuckDB)
---------------------------

SQLite is in the Python stdlib (zero install), is the canonical
durable-cache substrate, and has a battle-tested WAL-mode story for
concurrent readers + a single writer. DuckDB was the prior choice but
required a runtime dep and didn't buy us anything for this workload
(short transactional writes, occasional streaming reads of BLOBs).

Schema (with explicit SQLite affinity for every column)
-------------------------------------------------------

  btp_meta        key TEXT PK, value TEXT
  btp_traces      handle_idx INTEGER PK, path TEXT, mtime REAL,
                  metadata_json TEXT
  btp_queries     query_id TEXT PK, sql TEXT, started REAL,
                  completed REAL, total_traces INTEGER
  btp_results     query_id TEXT, handle_idx INTEGER, parquet BLOB,
                  num_rows INTEGER, executed REAL, error TEXT,
                  PRIMARY KEY (query_id, handle_idx)
  btp_failures    handle_idx INTEGER, kind TEXT, detail TEXT,
                  when_ts REAL, exit_code INTEGER, stderr_tail TEXT
  btp_config      key TEXT PK, value TEXT

Type discipline
---------------

We never round-trip Python's `bytes` through TEXT. The `parquet`
column is BLOB end-to-end — sqlite3 binds `bytes` directly and
yields `bytes` on read; we wrap with `io.BytesIO` for pyarrow.
Timestamps (mtime, started, completed, when_ts, executed) are stored
as REAL seconds since the epoch — matches `time.time()` and
`os.stat().st_mtime`. Counts and indexes are INTEGER. Strings are
TEXT; metadata is JSON-serialised TEXT.

Concurrency
-----------

The connection is opened with `check_same_thread=False` so worker
threads can call into it; we serialise writes with `_lock` and
enable `journal_mode=WAL` so reads don't block writes. Writes are
short (one to a few INSERTs per call) so a single connection holding
the lock briefly is fine — pipelining wouldn't help.
"""

from __future__ import annotations

import dataclasses as dc
import hashlib
import io
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


@dc.dataclass(frozen=True)
class TraceFingerprint:
  """What goes into the query_id hash for a single trace."""
  path: str
  mtime: float


@dc.dataclass(frozen=True)
class CachedQuery:
  """One row of `btp_queries` plus a denormalised result-row count."""
  query_id: str
  sql: str
  started: float
  completed: Optional[float]
  total_traces: int
  cached_traces: int

  @property
  def is_complete(self) -> bool:
    return (self.completed is not None and
            self.cached_traces == self.total_traces)


def fingerprint_traces(metas: List[Dict[str, str]]) -> List[TraceFingerprint]:
  """For each trace metadata dict, produce a (path, mtime) tuple.

  Path comes from `_path` (set by PathUriResolver / TracesWithMetadata).
  Traces without a `_path` fall back to a stable string from their
  metadata so the query_id remains deterministic — but they CAN'T be
  resumed across runs (if you restart, the in-memory generator is
  gone). The session emits a one-time warning for those."""
  fps: List[TraceFingerprint] = []
  for m in metas:
    p = m.get('_path')
    if p is None:
      key = json.dumps(m, sort_keys=True)
      fps.append(TraceFingerprint(path=f'<no_path>:{key}', mtime=0.0))
      continue
    try:
      mt = os.stat(p).st_mtime
    except OSError:
      mt = 0.0
    fps.append(TraceFingerprint(path=p, mtime=mt))
  return fps


def query_id_for(sql: str, fingerprints: List[TraceFingerprint]) -> str:
  """Stable hash. Independent of trace ORDERING — consumers should
  produce the same query_id whether their input list is sorted or
  not. (Each trace is identified by its (path, mtime) pair.)"""
  h = hashlib.sha256()
  h.update(sql.encode('utf-8'))
  h.update(b'\x00')
  for fp in sorted(fingerprints, key=lambda f: (f.path, f.mtime)):
    h.update(fp.path.encode('utf-8'))
    h.update(b'\x00')
    h.update(repr(fp.mtime).encode('utf-8'))
    h.update(b'\x00')
  return h.hexdigest()[:24]


def _df_to_parquet_bytes(df: pd.DataFrame) -> bytes:
  """Serialise a DataFrame to a parquet byte blob. Empty df → b''.
  We never write `None` for empty frames — that would force readers
  to special-case NULL vs zero-length BLOB."""
  if df is None or df.empty:
    return b''
  buf = io.BytesIO()
  pq.write_table(pa.Table.from_pandas(df, preserve_index=False), buf)
  return buf.getvalue()


def _parquet_bytes_to_df(blob: Optional[bytes]) -> pd.DataFrame:
  """Inverse of `_df_to_parquet_bytes`. Treats None and b'' the same:
  both mean "no rows for this (query_id, handle_idx)"."""
  if not blob:
    return pd.DataFrame()
  return pq.read_table(io.BytesIO(blob)).to_pandas()


# Schema text. Kept as a single multi-statement string so
# `executescript` runs all of it under one transaction.
_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS btp_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS btp_traces (
    handle_idx     INTEGER PRIMARY KEY,
    path           TEXT NOT NULL,
    mtime          REAL NOT NULL,
    metadata_json  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS btp_queries (
    query_id      TEXT PRIMARY KEY,
    sql           TEXT NOT NULL,
    started       REAL NOT NULL,
    completed     REAL,
    total_traces  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS btp_results (
    query_id    TEXT NOT NULL,
    handle_idx  INTEGER NOT NULL,
    parquet     BLOB NOT NULL,
    num_rows    INTEGER NOT NULL,
    executed    REAL NOT NULL,
    error       TEXT,
    PRIMARY KEY (query_id, handle_idx)
);
CREATE TABLE IF NOT EXISTS btp_failures (
    handle_idx   INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    detail       TEXT NOT NULL,
    when_ts      REAL NOT NULL,
    exit_code    INTEGER,
    stderr_tail  TEXT
);
CREATE INDEX IF NOT EXISTS btp_failures_when_ts ON btp_failures(when_ts);
CREATE TABLE IF NOT EXISTS btp_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Session:
  """Persistent state for one BTP run.

  Connection is owned by this object; concurrent access from worker
  threads goes through the public methods, which serialise via
  `_lock`. We open with `check_same_thread=False` so the same
  connection works across threads, and `journal_mode=WAL` so readers
  never block on writers."""

  SCHEMA_VERSION = 1

  def __init__(self, session_dir: Path) -> None:
    self.session_dir = Path(session_dir)
    self.session_dir.mkdir(parents=True, exist_ok=True)
    self.db_path = self.session_dir / 'btp.sqlite'
    self._lock = threading.Lock()
    # `isolation_level=None` so we drive transactions ourselves with
    # BEGIN/COMMIT — sqlite3's default ("legacy mode") opens implicit
    # transactions on first DML and we'd lose control over write
    # batching.
    self._con = sqlite3.connect(
        str(self.db_path),
        check_same_thread=False,
        isolation_level=None,
        timeout=30.0)
    # WAL gives concurrent readers without blocking the single
    # writer; NORMAL sync is durable across crashes (just not across
    # OS-level power loss, which we don't need).
    self._con.execute('PRAGMA journal_mode = WAL')
    self._con.execute('PRAGMA synchronous = NORMAL')
    self._con.execute('PRAGMA temp_store = MEMORY')
    self._con.execute('PRAGMA foreign_keys = ON')
    self._init_schema()

  # -- Public reads ---------------------------------------------------------

  def list_queries(self) -> List[CachedQuery]:
    """All queries this session has seen, newest first."""
    rows = self._con.execute("""
      SELECT q.query_id, q.sql, q.started, q.completed, q.total_traces,
             COALESCE(c.n, 0) AS cached_traces
      FROM btp_queries q
      LEFT JOIN (
          SELECT query_id, COUNT(*) AS n FROM btp_results GROUP BY query_id
      ) c USING (query_id)
      ORDER BY q.started DESC
    """).fetchall()
    return [
        CachedQuery(qid, sql, started, completed, total, cached)
        for (qid, sql, started, completed, total, cached) in rows
    ]

  def lookup_query(self, query_id: str) -> Optional[CachedQuery]:
    rows = self._con.execute(
        """
        SELECT q.query_id, q.sql, q.started, q.completed, q.total_traces,
               COALESCE(c.n, 0)
        FROM btp_queries q
        LEFT JOIN (
            SELECT query_id, COUNT(*) AS n FROM btp_results GROUP BY query_id
        ) c USING (query_id)
        WHERE q.query_id = ?
        """, (query_id,)).fetchall()
    if not rows:
      return None
    qid, sql, started, completed, total, cached = rows[0]
    return CachedQuery(qid, sql, started, completed, total, cached)

  def cached_handles(self, query_id: str) -> List[int]:
    """handle_idx values that already have a cached result for this
    query. Used to skip work on a partial cache hit."""
    rows = self._con.execute(
        'SELECT handle_idx FROM btp_results WHERE query_id = ? '
        'ORDER BY handle_idx', (query_id,)).fetchall()
    return [int(r[0]) for r in rows]

  def fetch_result(self, query_id: str,
                   handle_idx: int) -> Optional[pd.DataFrame]:
    rows = self._con.execute(
        'SELECT parquet FROM btp_results '
        'WHERE query_id = ? AND handle_idx = ?',
        (query_id, handle_idx)).fetchall()
    if not rows:
      return None
    return _parquet_bytes_to_df(rows[0][0])

  def iter_results(self, query_id: str) -> Iterator[Tuple[int, pd.DataFrame]]:
    """Stream every cached (handle_idx, df) for a query. Memory-safe;
    one row per yield. Uses a fresh cursor so other writers can
    interleave without us holding an implicit lock."""
    cur = self._con.cursor()
    cur.execute(
        'SELECT handle_idx, parquet FROM btp_results '
        'WHERE query_id = ? ORDER BY handle_idx', (query_id,))
    try:
      while True:
        row = cur.fetchone()
        if row is None:
          return
        yield int(row[0]), _parquet_bytes_to_df(row[1])
    finally:
      cur.close()

  def list_traces(self) -> pd.DataFrame:
    """Traces registered in this session as a DataFrame; metadata is
    flattened into top-level columns for natural filtering."""
    rows = self._con.execute('SELECT handle_idx, path, mtime, metadata_json '
                             'FROM btp_traces ORDER BY handle_idx').fetchall()
    out: List[Dict[str, Any]] = []
    for idx, path, mtime, mj in rows:
      rec: Dict[str, Any] = {
          'handle_idx': int(idx),
          '_path': path,
          'mtime': float(mtime),
      }
      if mj:
        try:
          rec.update(json.loads(mj))
        except (TypeError, ValueError):
          pass
      out.append(rec)
    return pd.DataFrame(out)

  def list_failures(self) -> pd.DataFrame:
    rows = self._con.execute(
        'SELECT handle_idx, kind, detail, when_ts, exit_code, stderr_tail '
        'FROM btp_failures ORDER BY when_ts').fetchall()
    return pd.DataFrame.from_records(
        rows,
        columns=[
            'handle_idx', 'kind', 'detail', 'when', 'exit_code', 'stderr_tail'
        ])

  def get_config(self, key: str) -> Optional[str]:
    rows = self._con.execute('SELECT value FROM btp_config WHERE key = ?',
                             (key,)).fetchall()
    return rows[0][0] if rows else None

  def list_config(self) -> Dict[str, str]:
    rows = self._con.execute('SELECT key, value FROM btp_config').fetchall()
    return {k: v for k, v in rows}

  # -- Public writes --------------------------------------------------------

  def upsert_traces(self, fingerprints: List[TraceFingerprint],
                    metadatas: List[Dict[str, str]]) -> None:
    """Idempotent: by handle_idx. Replaces every row in `btp_traces`
    so a re-launch with a smaller corpus doesn't leave stale rows."""
    assert len(fingerprints) == len(metadatas)
    payload = [(int(i), str(fp.path), float(fp.mtime), json.dumps(meta))
               for i, (fp, meta) in enumerate(zip(fingerprints, metadatas))]
    with self._lock:
      try:
        self._con.execute('BEGIN')
        self._con.execute('DELETE FROM btp_traces')
        self._con.executemany(
            'INSERT INTO btp_traces '
            '(handle_idx, path, mtime, metadata_json) '
            'VALUES (?, ?, ?, ?)', payload)
        self._con.execute('COMMIT')
      except Exception:
        self._con.execute('ROLLBACK')
        raise

  def begin_query(self, query_id: str, sql: str, total_traces: int) -> None:
    """Insert-or-no-op the queries row. Caller is OK to call this for
    every query, even on a full cache hit (no-op then)."""
    with self._lock:
      self._con.execute(
          """
          INSERT INTO btp_queries (query_id, sql, started, total_traces)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (query_id) DO NOTHING
          """, (str(query_id), str(sql), float(time.time()), int(total_traces)))

  def store_result(self, query_id: str, handle_idx: int, df: pd.DataFrame,
                   executed: float, error: Optional[str]) -> None:
    """Idempotent on (query_id, handle_idx). Re-running the same
    query against the same handle overwrites the prior row.

    `parquet` is BLOB; we bind a Python `bytes` and sqlite3 stores it
    raw. A zero-length blob means "ran successfully, no rows" — distinct
    from a NULL `error` (which means no error), so the (b'', None)
    pair is the canonical "completed empty" cell."""
    blob: bytes = _df_to_parquet_bytes(df)
    num_rows: int = int(len(df.index)) if df is not None else 0
    with self._lock:
      self._con.execute(
          """
          INSERT INTO btp_results
          (query_id, handle_idx, parquet, num_rows, executed, error)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (query_id, handle_idx) DO UPDATE SET
              parquet  = excluded.parquet,
              num_rows = excluded.num_rows,
              executed = excluded.executed,
              error    = excluded.error
          """, (str(query_id), int(handle_idx), sqlite3.Binary(blob), num_rows,
                float(executed), None if error is None else str(error)))

  def complete_query(self, query_id: str) -> None:
    with self._lock:
      self._con.execute(
          'UPDATE btp_queries SET completed = ? WHERE query_id = ?',
          (float(time.time()), str(query_id)))

  def store_failure(self, handle_idx: int, kind: str, detail: str,
                    exit_code: Optional[int],
                    stderr_tail: Optional[str]) -> None:
    with self._lock:
      self._con.execute(
          """
          INSERT INTO btp_failures
          (handle_idx, kind, detail, when_ts, exit_code, stderr_tail)
          VALUES (?, ?, ?, ?, ?, ?)
          """, (int(handle_idx), str(kind), str(detail), float(
              time.time()), None if exit_code is None else int(exit_code),
                None if stderr_tail is None else str(stderr_tail)))

  def set_config(self, key: str, value: str) -> None:
    with self._lock:
      self._con.execute(
          """
          INSERT INTO btp_config (key, value) VALUES (?, ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
          """, (str(key), str(value)))

  def db_size_bytes(self) -> int:
    """Current on-disk size of the SQLite (for the page's disk-usage
    pill)."""
    with self._lock:
      return self._db_size_bytes_locked()

  def _db_size_bytes_locked(self) -> int:
    try:
      page_count = self._con.execute('PRAGMA page_count').fetchone()[0]
      page_size = self._con.execute('PRAGMA page_size').fetchone()[0]
      return int(page_count) * int(page_size)
    except Exception:  # noqa: BLE001
      return 0

  # -- Lifecycle ------------------------------------------------------------

  def close(self) -> None:
    with self._lock:
      try:
        self._con.close()
      except Exception:  # noqa: BLE001
        pass

  def __enter__(self) -> 'Session':
    return self

  def __exit__(self, *_: object) -> None:
    self.close()

  # -- Internal -------------------------------------------------------------

  def _init_schema(self) -> None:
    with self._lock:
      self._con.executescript(_SCHEMA_SQL)
      self._con.execute(
          """
          INSERT INTO btp_meta (key, value) VALUES ('schema_version', ?)
          ON CONFLICT (key) DO NOTHING
          """, (str(self.SCHEMA_VERSION),))
