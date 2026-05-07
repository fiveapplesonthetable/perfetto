#!/usr/bin/env python3
# Copyright (C) 2020 The Android Open Source Project
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

import http.client
import threading
from typing import List, Optional, Union

from perfetto.trace_processor.protos import ProtoFactory


class TraceProcessorHttp:
  """Thin HTTP/1.1 client for `trace_processor_shell -D`.

  `http.client.HTTPConnection` is not safe for concurrent use: the request
  and response are stateful on the same socket. Every method serializes
  through `_lock` so multiple threads can hand the same TP to the pool
  without corrupting the wire protocol.
  """

  def __init__(self, url: str, protos: ProtoFactory):
    self.protos = protos
    self.conn = http.client.HTTPConnection(url)
    self._lock = threading.Lock()

  def _post_proto(self, path: str, body: bytes) -> bytes:
    with self._lock:
      self.conn.request('POST', path, body=body)
      with self.conn.getresponse() as f:
        return f.read()

  def _get(self, path: str) -> bytes:
    with self._lock:
      self.conn.request('GET', path)
      with self.conn.getresponse() as f:
        return f.read()

  def execute_query(self, query: str):
    args = self.protos.QueryArgs()
    args.sql_query = query
    payload = self._post_proto('/query', args.SerializeToString())
    result = self.protos.QueryResult()
    result.ParseFromString(payload)
    return result

  def compute_metric(self, metrics: List[str]):
    args = self.protos.ComputeMetricArgs()
    args.metric_names.extend(metrics)
    payload = self._post_proto('/compute_metric', args.SerializeToString())
    result = self.protos.ComputeMetricResult()
    result.ParseFromString(payload)
    return result

  def trace_summary(self,
                    specs: List[Union[str, bytes]],
                    metric_ids: Optional[List[str]] = None,
                    metadata_query_id: Optional[str] = None):
    args = self.protos.TraceSummaryArgs()

    if metric_ids is None:
      args.computation_spec.run_all_metrics = True
    elif len(metric_ids) > 0:
      args.computation_spec.metric_ids.extend(metric_ids)

    if specs:
      for spec in specs:
        if isinstance(spec, str):
          args.textproto_specs.append(spec)
        elif isinstance(spec, bytes):
          proto_spec = self.protos.TraceSummarySpec()
          proto_spec.ParseFromString(spec)
          args.proto_specs.append(proto_spec)

    if metadata_query_id is not None:
      args.computation_spec.metadata_query_id = metadata_query_id

    args.output_format = self.protos.TraceSummaryArgs.Format.BINARY_PROTOBUF
    payload = self._post_proto('/trace_summary', args.SerializeToString())
    result = self.protos.TraceSummaryResult()
    result.ParseFromString(payload)
    return result

  def parse(self, chunk: bytes):
    payload = self._post_proto('/parse', chunk)
    result = self.protos.AppendTraceDataResult()
    result.ParseFromString(payload)
    return result

  def notify_eof(self):
    return self._get('/notify_eof')

  def status(self):
    payload = self._get('/status')
    result = self.protos.StatusResult()
    result.ParseFromString(payload)
    return result

  def enable_metatrace(self):
    return self._get('/enable_metatrace')

  def disable_and_read_metatrace(self):
    payload = self._get('/disable_and_read_metatrace')
    result = self.protos.DisableAndReadMetatraceResult()
    result.ParseFromString(payload)
    return result

  def close(self) -> None:
    """Idempotent. Safe to call from another thread mid-request — the
    in-flight request will surface as a ConnectionError to the caller."""
    with self._lock:
      try:
        self.conn.close()
      except Exception:
        pass
