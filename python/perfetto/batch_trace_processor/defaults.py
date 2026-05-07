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
"""Sensible defaults derived from the host's resources, plus
JSON save/load for the user-facing config.

The user-facing budget surface is two knobs:

  * cpu_workers       — query parallelism (default: 50% of cores)
  * memory_budget_mb  — in-memory working set cap (default: 50% MemAvailable)

The slot count is derived from `memory_budget_mb` via a per-trace
estimate. The 50% defaults leave headroom for the analyst's notebooks,
browser, IDE, etc."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from perfetto.batch_trace_processor.linux import (
    read_meminfo_available_bytes,
    read_swap_total_bytes,
)


def auto_memory_budget_mb() -> Optional[int]:
  """Pick a reasonable in-memory budget for the BTP working set.

  Heuristic: 50% of `MemAvailable`. Big enough to give the working
  set room, small enough to leave headroom for the analyst's other
  tools (notebooks, browser, ...). Returns None if /proc/meminfo
  isn't available; caller then picks `memory_budget_mb` directly."""
  avail = read_meminfo_available_bytes()
  if avail <= 0:
    return None
  return max(256, avail // (2 * 1024 * 1024))


def auto_cpu_workers() -> int:
  """Default query parallelism: 50% of usable cores.

  We respect cgroup affinity (containers / jails report a smaller set
  via `sched_getaffinity` than `cpu_count`). Halving leaves room for
  the analyst's other interactive work — IDE, browser, notebook
  kernel — without starving them under heavy fan-out."""
  if hasattr(os, 'sched_getaffinity'):
    try:
      cores = max(1, len(os.sched_getaffinity(0)))
    except OSError:
      cores = max(1, os.cpu_count() or 1)
  else:
    cores = max(1, os.cpu_count() or 1)
  return max(1, cores // 2)


def total_machine_cores() -> int:
  """Total cores visible (for surfacing as a "50% of N" hint)."""
  if hasattr(os, 'sched_getaffinity'):
    try:
      return max(1, len(os.sched_getaffinity(0)))
    except OSError:
      pass
  return max(1, os.cpu_count() or 1)


def total_machine_memory_mb() -> Optional[int]:
  """Total available memory in MB (for the "50% of N" hint)."""
  avail = read_meminfo_available_bytes()
  if avail <= 0:
    return None
  return avail // (1024 * 1024)


def auto_query_workers() -> int:
  """Worker count for query parallelism. Respects cgroup affinity."""
  if hasattr(os, 'sched_getaffinity'):
    try:
      return max(1, len(os.sched_getaffinity(0)))
    except OSError:
      pass
  return max(1, os.cpu_count() or 1)


def save_config_json(config: Any, path: Path) -> None:
  """Persist a `BatchTraceProcessorConfig` (or any nested dataclass)
  as JSON. Skips fields that aren't JSON-serializable (e.g. Path is
  stringified; `preexec_fn` is dropped as it's a callable)."""
  Path(path).write_text(
      json.dumps(_to_jsonable(config), indent=2, sort_keys=True))


def load_config_json(path: Path) -> Dict[str, Any]:
  """Inverse of `save_config_json`. Returns a dict the caller can
  pass to `BatchTraceProcessorConfig(**...)` (or merge selectively).

  The dict's top-level keys map onto `BatchTraceProcessorConfig`
  fields; nested `tp_config` is also a dict."""
  return json.loads(Path(path).read_text())


def _to_jsonable(obj: Any) -> Any:
  """Recursive coercion to JSON-safe values."""
  import dataclasses as dc
  from enum import Enum
  if obj is None or isinstance(obj, (bool, int, float, str)):
    return obj
  if isinstance(obj, Enum):
    return obj.name
  if isinstance(obj, Path):
    return str(obj)
  if dc.is_dataclass(obj):
    out: Dict[str, Any] = {}
    for f in dc.fields(obj):
      v = getattr(obj, f.name)
      if callable(v) and not dc.is_dataclass(v):
        # Skip preexec_fn etc.
        continue
      try:
        out[f.name] = _to_jsonable(v)
      except (TypeError, ValueError):
        continue
    return out
  if isinstance(obj, dict):
    return {str(k): _to_jsonable(v) for k, v in obj.items()}
  if isinstance(obj, (list, tuple)):
    return [_to_jsonable(v) for v in obj]
  # Last-ditch: stringify.
  return str(obj)
