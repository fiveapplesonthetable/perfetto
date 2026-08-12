#!/usr/bin/env python3
# Copyright (C) 2024 The Android Open Source Project
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

from python.generators.diff_tests.testing import Path, DataPath
from python.generators.diff_tests.testing import Csv, TextProto
from python.generators.diff_tests.testing import DiffTestBlueprint
from python.generators.diff_tests.testing import TestSuite


class Startups(TestSuite):

  def test_hot_startups(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_hot.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,186969441973689,186969489302704,47329015,"androidx.benchmark.integration.macrobenchmark.target","hot"
        """))

  def test_warm_startups(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_warm.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,186982050780778,186982115528805,64748027,"androidx.benchmark.integration.macrobenchmark.target","warm"
        """))

  def test_cold_startups(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_cold.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,186974938196632,186975083989042,145792410,"androidx.benchmark.integration.macrobenchmark.target","cold"
        """))

  # A coalesced launch: launchingActivity#1 (1..3) spans two consecutive
  # activities. Its "launching:" slices are com.pkga (1..2) then com.pkgb (2..3).
  # The startup must be re-anchored to the launched package (com.pkgb) at ts=2,
  # not read from the async span start at ts=1. A plain launch
  # (launchingActivity#2) keeps its async span start (5, not the 5.2 where its
  # single "launching:" slice begins), preserving the intent-resolution prefix.
  def test_coalesced_startups_reanchored_minsdk33(self):
    return DiffTestBlueprint(
        trace=TextProto(r"""
        packet {
          timestamp: 1
          process_tree {
            processes { pid: 1000 uid: 1000 cmdline: "system_server" }
            threads { tid: 1000 tgid: 1000 }
          }
        }
        packet {
          ftrace_events {
            cpu: 0
            event { timestamp: 1000000000 pid: 1000
              print { buf: "S|1000|launchingActivity#1|0\n" } }
            event { timestamp: 1000000000 pid: 1000
              print { buf: "S|1000|launching: com.pkga|11\n" } }
            event { timestamp: 2000000000 pid: 1000
              print { buf: "F|1000|launching: com.pkga|11\n" } }
            event { timestamp: 2000000000 pid: 1000
              print { buf: "S|1000|launching: com.pkgb|22\n" } }
            event { timestamp: 3000000000 pid: 1000
              print { buf: "F|1000|launching: com.pkgb|22\n" } }
            event { timestamp: 3000000000 pid: 1000
              print { buf: "F|1000|launchingActivity#1|0\n" } }
            event { timestamp: 3000000000 pid: 1000
              print { buf: "I|1000|launchingActivity#1:completed-cold:com.pkgb\n" } }
            event { timestamp: 5000000000 pid: 1000
              print { buf: "S|1000|launchingActivity#2|0\n" } }
            event { timestamp: 5200000000 pid: 1000
              print { buf: "S|1000|launching: com.solo|33\n" } }
            event { timestamp: 6000000000 pid: 1000
              print { buf: "F|1000|launching: com.solo|33\n" } }
            event { timestamp: 6000000000 pid: 1000
              print { buf: "F|1000|launchingActivity#2|0\n" } }
            event { timestamp: 6000000000 pid: 1000
              print { buf: "I|1000|launchingActivity#2:completed-warm:com.solo\n" } }
          }
        }
        """),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT startup_id, ts, ts_end, dur, package, startup_type
        FROM android_startups
        ORDER BY startup_id;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        1,2000000000,3000000000,1000000000,"com.pkgb","cold"
        2,5000000000,6000000000,1000000000,"com.solo","warm"
        """))

  def test_hot_startups_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_hot.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,779860286416,779893485322,33198906,"com.google.android.googlequicksearchbox","hot"
        1,780778904571,780813944498,35039927,"androidx.benchmark.integration.macrobenchmark.target","hot"
        """))

  def test_warm_startups_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_warm.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,799979565075,800014194731,34629656,"com.google.android.googlequicksearchbox","hot"
        1,800868511677,800981929562,113417885,"androidx.benchmark.integration.macrobenchmark.target","[NULL]"
        """))

  def test_cold_startups_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_cold.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startups;
        SELECT * FROM android_startups;
        """,
        out=Csv("""
        "startup_id","ts","ts_end","dur","package","startup_type"
        0,791231114368,791501060868,269946500,"androidx.benchmark.integration.macrobenchmark.target","[NULL]"
        """))

  def test_android_startup_time_to_display_hot_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_hot.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,33198906,"[NULL]",1,"[NULL]",355
        1,35039927,537343160,4,5,383
        """))

  def test_android_startup_time_to_display_warm_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_warm.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,34629656,"[NULL]",1,"[NULL]",355
        1,108563770,581026583,4,5,388
        """))

  def test_android_startup_time_to_display_cold_maxsdk28(self):
    return DiffTestBlueprint(
        trace=DataPath('api24_startup_cold.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,264869885,715406822,65,66,396
        """))

  def test_android_startup_time_to_display_hot(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_hot.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,40534066,542222554,5872867,5872953,184
        """))

  def test_android_startup_time_to_display_warm(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_warm.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,62373965,555968701,5873800,5873889,185
        """))

  def test_android_startup_time_to_display_cold(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_cold.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.time_to_display;
        SELECT * FROM android_startup_time_to_display;
        """,
        out=Csv("""
        "startup_id","time_to_initial_display","time_to_full_display","ttid_frame_id","ttfd_frame_id","upid"
        0,143980066,620815843,5873276,5873353,229
        """))

  def test_android_startup_breakdown(self):
    return DiffTestBlueprint(
        trace=DataPath('api31_startup_cold.perfetto-trace'),
        query="""
        INCLUDE PERFETTO MODULE android.startup.startup_breakdowns;
        SELECT
          SUM(dur) AS dur,
          reason
          FROM android_startup_opinionated_breakdown
          GROUP BY reason ORDER BY dur DESC;
        """,
        out=Csv("""
        "dur","reason"
        28663023,"choreographer_do_frame"
        22564487,"binder"
        22011252,"launch_delay"
        16351925,"Running"
        13212137,"activity_start"
        10264635,"io"
        6779947,"inflate"
        6240207,"bind_application"
        5214375,"R+"
        3072397,"resources_manager_get_resources"
        2722869,"D"
        2574273,"open_dex_files_from_oat"
        2392761,"S"
        2353124,"activity_resume"
        1325727,"R"
        43698,"art_lock_contention"
        5573,"verify_class"
        """))
