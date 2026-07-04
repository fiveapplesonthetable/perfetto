--
-- Copyright 2026 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Per-displayed-frame work window for every process that composited into it.
--
-- Each SurfaceFlinger surface (app) frame from the frame timeline carries the
-- process (upid) that produced it, the display frame token it was composited
-- into, and its own [ts, dur] lifecycle -- which is the process's per-frame work
-- window. Multiple rows per display_token = the cross-app set for that frame.
CREATE PERFETTO TABLE android_frame_work_windows(
  -- SurfaceFlinger display frame token (the displayed frame).
  display_token LONG,
  -- Process that composited into the frame.
  upid JOINID(process.id),
  -- Best-effort process label (process name, else the surface layer's package).
  process_name STRING,
  -- Start of the process's work window for this frame.
  ts TIMESTAMP,
  -- Duration of the work window.
  dur DURATION
) AS
SELECT
  EXTRACT_ARG(s.arg_set_id, 'Display frame token') AS display_token,
  s.upid,
  COALESCE(
    p.name,
    str_split(replace(EXTRACT_ARG(s.arg_set_id, 'Layer name'), 'TX - ', ''), '/', 0),
    'upid ' || s.upid) AS process_name,
  s.ts,
  s.dur
FROM actual_frame_timeline_slice s
LEFT JOIN process p ON p.upid = s.upid
WHERE EXTRACT_ARG(s.arg_set_id, 'Surface frame token') IS NOT NULL;

-- linux.perf callstack samples attributed to each (displayed frame, process).
-- Keeps utid so callers can split by thread; callsite_id feeds a flamegraph via
-- the callstacks.stack_profile macros.
CREATE PERFETTO TABLE android_frame_callstack_samples(
  -- SurfaceFlinger display frame token.
  display_token LONG,
  -- Process the sample belongs to.
  upid JOINID(process.id),
  -- Process label.
  process_name STRING,
  -- Sampled thread (join `thread` to filter by thread).
  utid JOINID(thread.id),
  -- Callsite of the sample (join callstacks.stack_profile for the stack).
  callsite_id LONG,
  -- Timestamp of the sample.
  ts TIMESTAMP
) AS
SELECT w.display_token, w.upid, w.process_name, ps.utid, ps.callsite_id, ps.ts
FROM android_frame_work_windows w
JOIN thread th ON th.upid = w.upid
JOIN perf_sample ps ON ps.utid = th.utid AND ps.ts >= w.ts AND ps.ts < w.ts + w.dur;
