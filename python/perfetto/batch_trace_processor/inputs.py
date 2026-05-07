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
"""Input helpers for BatchTraceProcessor.

`TracesWithMetadata` lets the caller attach arbitrary string-valued
columns (device name, scenario, build id, ...) to each trace. The
metadata flows through the pool unchanged and is appended as columns
by `query_and_flatten` / `query_to_parquet`. Callers can pre-filter
their input list to query only a subset (e.g. `[(p, m) for p, m in
all_traces if m['device'] == 'pixel8']`).

Example:
  traces = TracesWithMetadata([
      ('runs/2026-05-01/cold-pixel8.pftrace',
       {'device': 'pixel8', 'scenario': 'cold-launch'}),
      ('runs/2026-05-01/cold-pixel7.pftrace',
       {'device': 'pixel7', 'scenario': 'cold-launch'}),
  ])
  with BatchTraceProcessor(traces) as btp:
      df = btp.query_and_flatten('select count(*) as slices from slice')
      pixel8 = df[df['device'] == 'pixel8']
"""

from __future__ import annotations

from typing import Iterable, List, Tuple

from perfetto.trace_uri_resolver import util
from perfetto.trace_uri_resolver.resolver import TraceUriResolver


class TracesWithMetadata(TraceUriResolver):
  """Resolver wrapping `(path, metadata)` pairs.

  `path` may be any path-like string. `metadata` is an arbitrary
  `Dict[str, str]` (values are stringified by the downstream pipeline
  when emitted as DataFrame columns).

  The PathUriResolver-set `_path` key is preserved so traces stay
  reloadable after eviction even when `metadata` doesn't carry one
  itself.
  """
  PREFIX = '__btp_with_metadata__'

  def __init__(self, items: Iterable[Tuple[str, dict]]):
    self._items: List[Tuple[str, dict]] = []
    for path, meta in items:
      if not isinstance(path, str):
        raise TypeError('TracesWithMetadata expects (path, metadata) tuples; '
                        f'got path of type {type(path).__name__}')
      if meta is None:
        meta = {}
      if '_path' in meta and meta['_path'] != path:
        raise ValueError(f'metadata for {path!r} carries conflicting _path '
                         f'{meta["_path"]!r}; drop _path or fix it to match')
      self._items.append((path, dict(meta)))

  def resolve(self) -> List[TraceUriResolver.Result]:
    out: List[TraceUriResolver.Result] = []
    for path, meta in self._items:
      merged = dict(meta)
      merged.setdefault('_path', path)
      out.append(
          TraceUriResolver.Result(
              trace=util.file_generator(path), metadata=merged))
    return out

  def __len__(self) -> int:
    return len(self._items)
