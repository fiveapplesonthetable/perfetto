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
"""HTTP/JSON server — the BTP daemon's wire contract.

This file IS the contract. Anything that speaks the same shapes is a
drop-in replacement: the bigtrace UI hits these endpoints and nothing
else. Stdlib `http.server` is enough — the workload is low-rate
control plane (a few requests/sec per UI session), not high
throughput.

Endpoints (JSON unless noted):

    GET  /info             snapshot:
        {trace_count, max_loaded, pool_mode, session_dir,
         cpu_workers, memory_budget_mb, query_timeout_s,
         machine_cores_total, machine_memory_mb_total,
         loaded, loading, evicted, running,
         running_handles: [{handle_idx, _path, state, pin_count,
                            load_count}, ...],
         memory_used_mb,
         total_reloads, load_failures,
         failure_counts: {kind: n, ...}}

    GET  /traces           [{handle_idx, state, pin_count, load_count,
                             _path?, ...metadata}, ...]
    POST /traces           {path, metadata?} -> {handle_idx}

    GET  /queries          [{query_id, sql, started, completed,
                             total_traces, cached_traces,
                             is_complete}, ...]
    GET  /query/<qid>      single record (same shape as above)
    GET  /results/<qid>    [row, ...]; ?format=arrow streams Arrow IPC
    POST /run              {sql} -> {query_id}  (synchronous)

    GET  /progress         {query_id, sql, total, completed, failed,
                            started_ts, eta_s} or empty when idle
    GET  /failures         [{handle_idx, kind, detail, when,
                             exit_code?, stderr_tail?}, ...]

    GET  /config           full config dict
    POST /config           partial patch -> {config, info}.
                           Honoured live: cpu_workers,
                           memory_budget_mb, query_timeout_s.
    POST /cancel           cancel any in-flight query
    POST /shutdown         clean stop of the server thread

CORS echoes `Origin` and sets `Allow-Credentials: true` so a UI
served from a different host (e.g. the bigtrace dev server on a
Tailscale node) can hit the daemon without preflight failures.
"""

from __future__ import annotations

import io
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
  from perfetto.batch_trace_processor.api import BatchTraceProcessor

log = logging.getLogger('perfetto.btp.server')


def _set_cors_headers(handler: BaseHTTPRequestHandler) -> None:
  """Permissive CORS that's compatible with `credentials: 'include'`.

  The bigtrace UI's settings/query fetches send `credentials:
  'include'`, which means the browser refuses a wildcard `*` ACAO
  header — it must echo back the request `Origin`. We do that, plus
  `Allow-Credentials: true`. Falls back to `*` only when no Origin
  header is present (curl, server-to-server)."""
  origin = handler.headers.get('Origin', '')
  if origin:
    handler.send_header('Access-Control-Allow-Origin', origin)
    handler.send_header('Vary', 'Origin')
    handler.send_header('Access-Control-Allow-Credentials', 'true')
  else:
    handler.send_header('Access-Control-Allow-Origin', '*')
  handler.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  handler.send_header('Access-Control-Allow-Headers', 'Content-Type')


def _sanitize_for_json(obj: Any) -> Any:
  """Recursively coerce non-JSON-spec floats (NaN, +/-Inf) and pandas
  sentinels into nulls.

  pandas `to_dict(orient='records')` produces NaN floats for missing
  cells; `json.dumps` defaults to `allow_nan=True` which emits the
  bareword `NaN`, which isn't valid JSON and breaks `JSON.parse` in
  the browser. We collapse all of those into `None` here so the wire
  format is strictly JSON-spec."""
  import math
  if obj is None:
    return None
  if isinstance(obj, float):
    if math.isnan(obj) or math.isinf(obj):
      return None
    return obj
  if isinstance(obj, dict):
    return {k: _sanitize_for_json(v) for k, v in obj.items()}
  if isinstance(obj, (list, tuple)):
    return [_sanitize_for_json(v) for v in obj]
  return obj


def _json_response(handler: BaseHTTPRequestHandler,
                   payload: Any,
                   status: int = 200) -> None:
  payload = _sanitize_for_json(payload)
  body = json.dumps(payload, default=str, allow_nan=False).encode('utf-8')
  handler.send_response(status)
  handler.send_header('Content-Type', 'application/json; charset=utf-8')
  handler.send_header('Content-Length', str(len(body)))
  _set_cors_headers(handler)
  handler.end_headers()
  handler.wfile.write(body)


def _arrow_response(handler: BaseHTTPRequestHandler, table) -> None:
  """Stream a pyarrow Table as Arrow IPC. Lets the UI / a native
  client zero-copy the result rather than going through JSON."""
  import pyarrow as pa
  buf = io.BytesIO()
  with pa.ipc.new_stream(buf, table.schema) as writer:
    writer.write_table(table)
  body = buf.getvalue()
  handler.send_response(200)
  handler.send_header('Content-Type', 'application/vnd.apache.arrow.stream')
  handler.send_header('Content-Length', str(len(body)))
  _set_cors_headers(handler)
  handler.end_headers()
  handler.wfile.write(body)


def _make_handler(btp: 'BatchTraceProcessor', server_holder: dict) -> type:

  class Handler(BaseHTTPRequestHandler):
    """One handler instance per request (ThreadingHTTPServer)."""

    # Quieter default log; let the BTP logger speak instead.
    def log_message(self, fmt, *args) -> None:  # noqa: A003
      log.debug('%s - %s', self.address_string(), fmt % args)

    def do_OPTIONS(self) -> None:  # noqa: N802
      self.send_response(204)
      _set_cors_headers(self)
      self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
      try:
        path = self.path.split('?', 1)
        path_only = path[0]
        query = path[1] if len(path) == 2 else ''
        params = dict(p.split('=', 1) for p in query.split('&') if '=' in p)
        if path_only == '/info':
          return _json_response(self, btp.info())
        if path_only == '/traces':
          # Live per-trace state — every handle in the pool gets one
          # row with both static metadata AND live state so the
          # Traces DataGrid can show what each trace is doing right
          # now. The DataGrid virtualises rows so this scales to
          # 10s of thousands of traces.
          rows: list = []
          for snap in btp.pool_handle_snapshot():
            rec: dict = {k: v for k, v in snap.items() if k != 'metadata'}
            for k, v in (snap.get('metadata') or {}).items():
              rec.setdefault(k, v)
            rows.append(rec)
          return _json_response(self, rows)
        if path_only == '/queries':
          return _json_response(self, [{
              'query_id': q.query_id,
              'sql': q.sql,
              'started': q.started,
              'completed': q.completed,
              'total_traces': q.total_traces,
              'cached_traces': q.cached_traces,
              'is_complete': q.is_complete,
          } for q in btp.session.list_queries()])
        if path_only.startswith('/query/'):
          qid = path_only[len('/query/'):]
          q = btp.session.lookup_query(qid)
          if q is None:
            return _json_response(self, {'error': 'not found'}, 404)
          return _json_response(
              self, {
                  'query_id': q.query_id,
                  'sql': q.sql,
                  'started': q.started,
                  'completed': q.completed,
                  'total_traces': q.total_traces,
                  'cached_traces': q.cached_traces,
                  'is_complete': q.is_complete,
              })
        if path_only.startswith('/results/'):
          qid = path_only[len('/results/'):]
          fmt = params.get('format', 'json')
          if fmt == 'arrow':
            import pyarrow as pa
            tables = []
            for handle_idx, df in btp.session.iter_results(qid):
              if df.empty:
                continue
              df['_handle_idx'] = handle_idx
              tables.append(pa.Table.from_pandas(df, preserve_index=False))
            if not tables:
              return _json_response(self, [], 200)
            schema = tables[0].schema
            tables = [t.cast(schema) for t in tables]
            return _arrow_response(self, pa.concat_tables(tables))
          # JSON path: row-oriented for agent ergonomics.
          rows = []
          for handle_idx, df in btp.session.iter_results(qid):
            for rec in df.to_dict(orient='records'):
              rec['_handle_idx'] = handle_idx
              rows.append(rec)
          return _json_response(self, rows)
        if path_only == '/progress':
          return _json_response(self, btp.progress().to_dict())
        if path_only == '/failures':
          return _json_response(self, btp._failures.to_records())
        if path_only == '/config':
          return _json_response(self, btp.config_dict())
        return _json_response(self, {'error': 'unknown route'}, 404)
      except Exception as ex:  # noqa: BLE001
        log.exception('GET %s failed', self.path)
        return _json_response(self, {'error': str(ex)}, 500)

    def do_POST(self) -> None:  # noqa: N802
      try:
        length = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(length) if length > 0 else b''
        try:
          payload = json.loads(body.decode('utf-8') or '{}')
        except ValueError:
          return _json_response(self, {'error': 'bad json'}, 400)
        if self.path == '/run':
          sql = payload.get('sql')
          if not isinstance(sql, str):
            return _json_response(self, {'error': 'sql required'}, 400)
          qid = btp.run_query(sql)
          return _json_response(self, {'query_id': qid})
        if self.path == '/cancel':
          btp.cancel()
          return _json_response(self, {'ok': True})
        if self.path == '/config':
          btp.update_config(payload)
          # Echo back the resolved info — clients can re-render their
          # status display from the same response (one round-trip).
          return _json_response(self, {
              'config': btp.config_dict(),
              'info': btp.info(),
          })
        if self.path == '/bigtrace_execution_config':
          # Brush-style "execution settings" — choices a user picks
          # before running a query (cluster, dataset, sample fraction,
          # ...). BTP doesn't expose any of those (the BTP itself is
          # the execution context), so return an empty list. The UI
          # degrades gracefully — no execution-settings card is shown.
          return _json_response(self, {'setting': []})
        if self.path == '/trace_metadata_settings':
          # Build real per-trace-metadata facets from the live pool.
          # For every metadata key (excluding `_path` / `mtime`),
          # collect the distinct values across handles and emit a
          # multi-select setting the bigtrace UI can render as a
          # filter chip group.
          facets: dict = {}
          for snap in btp.pool_handle_snapshot():
            for k, v in (snap.get('metadata') or {}).items():
              if k in ('_path', 'mtime') or k.startswith('_'):
                continue
              facets.setdefault(k, {}).setdefault(str(v), 0)
              facets[k][str(v)] += 1
          settings_out: list = []
          for key in sorted(facets.keys()):
            counts = facets[key]
            options = [{
                'value': v,
                'label': f'{v} ({n} traces)',
            } for v, n in sorted(counts.items())]
            settings_out.append({
                'id': f'btp_meta__{key}',
                'name': key,
                'description': (f'Filter traces by {key}. Values come '
                                f'from each trace\'s metadata as '
                                f'attached via TracesWithMetadata or '
                                f'--metadata-json.'),
                'category': 'TRACE_METADATA',
                'multiSelect': {
                    'defaultValues': [],
                    'options': options,
                },
            })
          return _json_response(self, {'setting': settings_out})
        if self.path == '/traces':
          # Live-register a new trace. Body shape:
          #   {"path": "/abs/or/rel/path", "metadata": {"k": "v", ...}}
          # `metadata` is optional. Returns the new handle index.
          path_arg = payload.get('path')
          if not isinstance(path_arg, str) or not path_arg:
            return _json_response(self, {'error': 'path required'}, 400)
          meta = payload.get('metadata') or {}
          if not isinstance(meta, dict):
            return _json_response(self, {'error': 'metadata must be obj'}, 400)
          # Stringify metadata values — the BTP pipeline assumes string.
          meta = {str(k): str(v) for k, v in meta.items()}
          idx = btp.add_trace(path_arg, meta)
          return _json_response(self, {'handle_idx': idx})
        if self.path == '/shutdown':
          srv = server_holder.get('server')
          if srv is not None:
            threading.Thread(target=srv.shutdown, daemon=True).start()
          return _json_response(self, {'ok': True})
        return _json_response(self, {'error': 'unknown route'}, 404)
      except Exception as ex:  # noqa: BLE001
        log.exception('POST %s failed', self.path)
        return _json_response(self, {'error': str(ex)}, 500)

  return Handler


class BtpServer:
  """Wraps `ThreadingHTTPServer` with a BTP instance for the
  handler. Daemon thread; `close()` is idempotent."""

  def __init__(self,
               btp: 'BatchTraceProcessor',
               host: str = '127.0.0.1',
               port: int = 0) -> None:
    self._holder: dict = {}
    handler_cls = _make_handler(btp, self._holder)
    self._server = ThreadingHTTPServer((host, port), handler_cls)
    self._holder['server'] = self._server
    self.host, self.port = self._server.server_address
    self._thread = threading.Thread(
        target=self._server.serve_forever, name='btp-server', daemon=True)
    self._thread.start()

  @property
  def url(self) -> str:
    return f'http://{self.host}:{self.port}'

  def close(self) -> None:
    try:
      self._server.shutdown()
    except Exception:  # noqa: BLE001
      pass
    try:
      self._server.server_close()
    except Exception:  # noqa: BLE001
      pass
