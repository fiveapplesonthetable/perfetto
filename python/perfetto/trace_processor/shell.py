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

import os
import subprocess
import sys
import tempfile
import time
import shutil
from typing import List, Optional, Union
from urllib import request, error

from perfetto.common.exceptions import PerfettoException
from perfetto.trace_processor.platform import PlatformDelegate

# Import TYPE_CHECKING to avoid circular imports
from typing import TYPE_CHECKING
if TYPE_CHECKING:
  from perfetto.trace_processor.api import SqlPackage

# Default port that trace_processor_shell runs on
TP_PORT = 9001


class LoadTimeoutError(PerfettoException):
  """Raised by `load_shell` when /status didn't come up within
  `load_timeout` seconds. The child was alive at the deadline and got
  killed by us. BatchTraceProcessor classifies this as
  `kind='load_timeout'`."""

  def __init__(self, msg: str, stderr_tail: Optional[str] = None) -> None:
    super().__init__(msg)
    self.stderr_tail = stderr_tail


class LoadFailedError(PerfettoException):
  """Raised by `load_shell` when the child process exited before
  /status came up — a real crash during startup, not a timeout.
  Carries `exit_code` and a tail of the child's stderr so callers can
  distinguish RLIMIT_AS / segfaults / config-rejection."""

  def __init__(self,
               msg: str,
               exit_code: Optional[int] = None,
               stderr_tail: Optional[str] = None) -> None:
    super().__init__(msg)
    self.exit_code = exit_code
    self.stderr_tail = stderr_tail


def load_shell(
    bin_path: Optional[str],
    unique_port: bool,
    verbose: bool,
    ingest_ftrace_in_raw: bool,
    enable_dev_features: bool,
    platform_delegate: PlatformDelegate,
    load_timeout: int = 30,
    extra_flags: Optional[List[str]] = None,
    add_sql_packages: Optional[List[Union[str, 'SqlPackage']]] = None,
    preexec_fn=None,
):
  addr, port = platform_delegate.get_bind_addr(
      port=0 if unique_port else TP_PORT)
  url = f'{addr}:{str(port)}'

  shell_path = platform_delegate.get_shell_path(bin_path=bin_path)

  # get Python interpreter path
  if not getattr(sys, 'frozen', False):
    python_executable_path = sys.executable
  else:
    python_executable_path = shutil.which('python')

  if os.name == 'nt' and not shell_path.endswith('.exe'):
    tp_exec = [python_executable_path, shell_path]
  else:
    tp_exec = [shell_path]

  args = ['-D', '--http-port', str(port)]
  if not ingest_ftrace_in_raw:
    args.append('--no-ftrace-raw')

  if enable_dev_features:
    args.append('--dev')

  if add_sql_packages:
    for package in add_sql_packages:
      if isinstance(package, str):
        args.extend(['--add-sql-package', package])
      else:
        # It's a SqlPackage object
        pkg_str = package.path
        if package.package:
          pkg_str += f'@{package.package}'
        args.extend(['--add-sql-package', pkg_str])

  if extra_flags:
    args.extend(extra_flags)

  temp_stdout = tempfile.TemporaryFile()
  temp_stderr = tempfile.TemporaryFile()

  creationflags = 0
  if sys.platform == 'win32':
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

  popen_kwargs = dict(
      stdin=subprocess.DEVNULL,
      stdout=temp_stdout,
      stderr=None if verbose else temp_stderr,
      creationflags=creationflags,
  )
  # `preexec_fn` runs in the child after fork(), before exec(). Used
  # by BatchTraceProcessor to set RLIMIT_AS as a hard kernel-level
  # per-trace VM cap. Skipped on win32 since subprocess.Popen rejects
  # it. (We deliberately don't use PR_SET_PDEATHSIG here — see
  # batch_trace_processor.linux for the reasoning.)
  if preexec_fn is not None and sys.platform != 'win32':
    popen_kwargs['preexec_fn'] = preexec_fn
  p = subprocess.Popen(tp_exec + args, **popen_kwargs)

  # Poll /status with exponential backoff (50ms -> 1s) up to load_timeout
  # seconds. The previous fixed 1-second sleep both burned wall-time on
  # fast spawns and gave too few retries when many shells were starting
  # concurrently.
  success = False
  child_died = False
  deadline = time.monotonic() + max(1, load_timeout)
  delay = 0.05
  while time.monotonic() < deadline:
    if p.poll() is not None:
      child_died = True
      break
    try:
      _ = request.urlretrieve(f'http://{url}/status')
      success = True
      break
    except (error.URLError, ConnectionError):
      time.sleep(delay)
      delay = min(delay * 2, 1.0)

  if not success:
    p.kill()
    exit_code = p.poll()
    temp_stdout.seek(0)
    stdout = temp_stdout.read().decode("utf-8")
    temp_stderr.seek(0)
    stderr = temp_stderr.read().decode("utf-8")
    temp_stdout.close()
    temp_stderr.close()
    if child_died:
      # Process exited before /status came up — a real crash, not a
      # timeout. Caller can classify against rlimit / oom signals.
      raise LoadFailedError(
          f"Trace processor exited during startup (exit_code={exit_code}).\n"
          f"stdout: {stdout}\nstderr: {stderr}\n",
          exit_code=exit_code,
          stderr_tail=stderr[-4096:])
    raise LoadTimeoutError(
        f"Trace processor failed to start within {load_timeout}s.\n"
        f"stdout: {stdout}\nstderr: {stderr}\n",
        stderr_tail=stderr[-4096:])

  return url, p, temp_stdout, temp_stderr
