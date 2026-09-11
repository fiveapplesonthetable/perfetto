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

import json

from python.generators.diff_tests.testing import Csv
from python.generators.diff_tests.testing import Tar, TextProto
from python.generators.diff_tests.testing import DiffTestBlueprint
from python.generators.diff_tests.testing import TestSuite

_HOUR_NS = 3600 * 1000 * 1000 * 1000


def _proto_trace(boottime_ns,
                 realtime_ns,
                 machine='aarch64',
                 comm='work',
                 with_snapshot=True):
  """A proto trace with sched and cpufreq events on cpu 0.

  The snapshot's REALTIME - BOOTTIME is the boot fingerprint; `machine` varies
  the SystemInfo device identity.
  """
  snapshot = f'''
  packet {{
    trusted_packet_sequence_id: 1
    clock_snapshot {{
      clocks {{ clock_id: 6 timestamp: {boottime_ns} }}
      clocks {{ clock_id: 1 timestamp: {realtime_ns} }}
    }}
  }}''' if with_snapshot else ''
  return TextProto(f'''{snapshot}
  packet {{
    trusted_packet_sequence_id: 1
    system_info {{
      utsname {{
        sysname: "Linux" release: "6.1.0" version: "#1" machine: "{machine}"
      }}
    }}
  }}
  packet {{
    ftrace_events {{
      cpu: 0
      event {{
        timestamp: {boottime_ns + 100000000}
        pid: 100
        sched_switch {{
          prev_comm: "swapper" prev_pid: 0 prev_prio: 120 prev_state: 0
          next_comm: "{comm}" next_pid: 100 next_prio: 120
        }}
      }}
      event {{
        timestamp: {boottime_ns + 150000000}
        pid: 100
        cpu_frequency {{ cpu_id: 0 state: 1000000 }}
      }}
      event {{
        timestamp: {boottime_ns + 200000000}
        pid: 100
        sched_switch {{
          prev_comm: "{comm}" prev_pid: 100 prev_prio: 120 prev_state: 1
          next_comm: "swapper" next_pid: 0 next_prio: 120
        }}
      }}
    }}
  }}
  ''')


_BOOT_A = 5_000_000_000
_RT_A = 1_600_000_000_000_000_000


class Merging(TestSuite):
  """Machine attribution when merging trace files without a manifest.

  A file with no other attribution is keyed on the boot (and device) it was
  recorded on, read from its first ClockSnapshot (REALTIME - BOOTTIME) and
  SystemInfo packets: files from the same boot share a machine, independent
  recordings get their own, so their sched slices and cpu/gpu counters never
  interleave.
  """

  # Same device rebooted an hour later: BOOTTIME restarts while REALTIME
  # advances, so the fingerprints contradict and the second file gets its own
  # machine, named after the file. Each machine keeps its own sched timeline
  # and cpufreq track.
  def test_different_boots_get_separate_machines(self):
    return DiffTestBlueprint(
        trace=Tar({
            'first.pb':
                _proto_trace(_BOOT_A, _RT_A),
            'second.pb':
                _proto_trace(3_000_000_000, _RT_A + _HOUR_NS),
        }),
        query='''
          SELECT
            (SELECT count(*) FROM machine) AS machines,
            (SELECT name FROM machine WHERE raw_id != 0) AS second_machine,
            (SELECT count(DISTINCT machine_id)
             FROM track WHERE name = 'cpufreq') AS cpufreq_machines,
            (SELECT count(DISTINCT ucpu) FROM sched) AS sched_ucpus;
        ''',
        out=Csv('''
        "machines","second_machine","cpufreq_machines","sched_ucpus"
        2,"second.pb",2,2
        '''))

  # Two recordings of one boot (identical snapshot): one machine, one shared
  # cpu, a single unified sched timeline.
  def test_same_boot_shares_machine(self):
    return DiffTestBlueprint(
        trace=Tar({
            'first.pb': _proto_trace(_BOOT_A, _RT_A),
            'second.pb': _proto_trace(_BOOT_A, _RT_A, comm='other'),
        }),
        query='''
          SELECT
            (SELECT count(*) FROM machine) AS machines,
            (SELECT count(DISTINCT ucpu) FROM sched) AS sched_ucpus;
        ''',
        out=Csv('''
        "machines","sched_ucpus"
        1,1
        '''))

  # REALTIME adjusted (e.g. NTP) by a couple of seconds between two recordings
  # of one boot: still within tolerance, still one machine.
  def test_realtime_drift_within_tolerance_shares_machine(self):
    return DiffTestBlueprint(
        trace=Tar({
            'first.pb':
                _proto_trace(_BOOT_A, _RT_A),
            'second.pb':
                _proto_trace(_BOOT_A, _RT_A + 2_000_000_000, comm='other'),
        }),
        query='SELECT count(*) AS machines FROM machine;',
        out=Csv('''
        "machines"
        1
        '''))

  # Two devices whose boots coincide in wall-clock time: the SystemInfo
  # identity differs, so they are still separated.
  def test_different_devices_same_boot_time(self):
    return DiffTestBlueprint(
        trace=Tar({
            'first.pb': _proto_trace(_BOOT_A, _RT_A),
            'second.pb': _proto_trace(_BOOT_A, _RT_A, machine='x86_64'),
        }),
        query='SELECT count(*) AS machines FROM machine;',
        out=Csv('''
        "machines"
        2
        '''))

  # A manifest machine assignment takes precedence over the fingerprint: two
  # different boots explicitly attributed to one machine stay together.
  def test_manifest_overrides_boot_fingerprint(self):
    return DiffTestBlueprint(
        trace=Tar({
            'meta.json':
                json.dumps({
                    'perfetto_manifest': {
                        'version':
                            1,
                        'files': [
                            {
                                'path': 'first.pb',
                                'machine': {
                                    'name': 'lab-phone'
                                }
                            },
                            {
                                'path': 'second.pb',
                                'machine': {
                                    'name': 'lab-phone'
                                }
                            },
                        ],
                    }
                }),
            'first.pb':
                _proto_trace(_BOOT_A, _RT_A),
            'second.pb':
                _proto_trace(3_000_000_000, _RT_A + _HOUR_NS),
        }),
        query='''
          SELECT count(*) AS machines,
                 (SELECT name FROM machine LIMIT 1) AS name
          FROM machine;
        ''',
        out=Csv('''
        "machines","name"
        1,"lab-phone"
        '''))

  # A file with no snapshot has no fingerprint and keeps today's behaviour of
  # sharing the host machine.
  def test_fingerprintless_file_shares_host(self):
    return DiffTestBlueprint(
        trace=Tar({
            'first.pb':
                _proto_trace(_BOOT_A, _RT_A),
            'second.pb':
                _proto_trace(_BOOT_A, _RT_A, comm='other',
                             with_snapshot=False),
        }),
        query='SELECT count(*) AS machines FROM machine;',
        out=Csv('''
        "machines"
        1
        '''))
