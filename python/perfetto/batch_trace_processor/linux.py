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
"""Linux-specific helpers: ulimit nudge, /proc inspection, prctl, RLIMIT.

These all degrade to no-ops on non-Linux platforms — callers don't
need to branch on `os.name`. The cgroup parts live in `cgroup.py`.
"""

from __future__ import annotations

import logging
import os
import resource
import sys
from pathlib import Path
from typing import Optional

log = logging.getLogger('perfetto.btp.linux')

# Per-trace headroom for fd / proc accounting. One TP costs roughly:
#   ~6 fds   (stdin/out/err + http listen + tempfiles)
#   ~1 proc
# We scale by 4x to be safe and account for Python's own bookkeeping.
_FDS_PER_TRACE = 8
_PROCS_PER_TRACE = 2


def ulimit_check(num_traces: int) -> None:
  """One-shot warning if the user's ulimits look tight for `num_traces`.

  Doesn't raise, doesn't auto-bump. Just nudges via the logger so a
  user staring at "Too many open files" or "Resource temporarily
  unavailable" knows what to do."""
  need_fds = num_traces * _FDS_PER_TRACE
  need_procs = num_traces * _PROCS_PER_TRACE
  try:
    nofile_soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
  except (OSError, ValueError):
    nofile_soft = -1
  try:
    nproc_soft, _ = resource.getrlimit(resource.RLIMIT_NPROC)
  except (OSError, ValueError):
    nproc_soft = -1

  warnings = []
  if 0 < nofile_soft < need_fds:
    warnings.append(f'RLIMIT_NOFILE={nofile_soft}, recommend >= {need_fds} '
                    f'(`ulimit -n {max(65536, need_fds)}`)')
  if 0 < nproc_soft < need_procs:
    warnings.append(f'RLIMIT_NPROC={nproc_soft}, recommend >= {need_procs} '
                    f'(`ulimit -u {max(65536, need_procs)}`)')
  if warnings:
    log.warning('btp: %d traces but ulimits look tight: %s', num_traces,
                '; '.join(warnings))


def read_swap_total_bytes() -> int:
  """Sum of all swap devices (disk + zram). 0 if /proc/swaps is
  unreadable or no swap is configured."""
  try:
    with open('/proc/swaps', 'r') as f:
      lines = f.readlines()[1:]  # skip header
  except OSError:
    return 0
  total_kb = 0
  for line in lines:
    parts = line.split()
    if len(parts) >= 3:
      try:
        total_kb += int(parts[2])
      except ValueError:
        continue
  return total_kb * 1024


def read_meminfo_available_bytes() -> int:
  """`MemAvailable` from /proc/meminfo. Returns 0 on non-Linux or
  read failure. This is the metric the kernel itself recommends for
  "how much memory could a new workload use without swapping" —
  better than `MemFree` which excludes reclaimable cache."""
  try:
    with open('/proc/meminfo', 'r') as f:
      for line in f:
        if line.startswith('MemAvailable:'):
          parts = line.split()
          # Format: "MemAvailable:    12345678 kB"
          if len(parts) >= 2:
            return int(parts[1]) * 1024
  except (OSError, ValueError):
    pass
  return 0
