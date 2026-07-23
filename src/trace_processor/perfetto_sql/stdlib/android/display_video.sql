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

-- Correlates `android.display.video` capture frames with the SurfaceFlinger
-- frame timeline.
--
-- A display-video frame is the encoded output of a virtual-display composite.
-- When SurfaceFlinger stamps the mirror output buffer with the composite's
-- expected present time, the encoded frame's presentation time equals that present
-- time. `__intrinsic_video_frames.ts` is that presentation time already translated
-- to the trace clock by the importer, and the frame-timeline slices are on the
-- same clock, so each frame is matched directly to the DisplayFrame whose expected
-- present (ts + dur) is closest. Frames are ~16ms apart, so the nearest match --
-- typically within a few microseconds -- is unambiguous.
CREATE PERFETTO TABLE android_display_video_frames(
  -- `__intrinsic_video_frames.id` of the frame.
  id LONG,
  -- Frame capture timestamp (trace clock).
  ts TIMESTAMP,
  -- Source display id.
  display_id LONG,
  -- Sequential frame number within the capture session.
  frame_number LONG,
  -- 1 if this is a key frame (IDR).
  is_key_frame LONG,
  -- Codec presentation timestamp (us); equals the composite present time.
  pts_us LONG,
  -- Frame-timeline vsync id (DisplayFrame token) of the composite that produced
  -- this frame, matched by nearest present time. NULL if no composite is within
  -- the match window (e.g. frames captured before the frame timeline started
  -- recording).
  vsync_id LONG,
  -- Absolute gap (ns) between the frame's present time and the matched
  -- DisplayFrame's expected present. A few microseconds for a good match.
  vsync_gap_ns LONG
) AS
WITH
  -- Present time (trace clock) of each DisplayFrame, keyed by its vsync id.
  -- `surface_frame_token IS NULL` selects display frames (not surface frames); the
  -- slice's end (ts + dur) is the present. Both the expected and actual timelines
  -- are used so a frame still matches when only one was recorded.
  display_frame AS (
    SELECT display_frame_token AS vsync_id, ts + dur AS present_ts
    FROM expected_frame_timeline_slice
    WHERE surface_frame_token IS NULL AND display_frame_token IS NOT NULL
    UNION
    SELECT display_frame_token AS vsync_id, ts + dur AS present_ts
    FROM actual_frame_timeline_slice
    WHERE surface_frame_token IS NULL AND display_frame_token IS NOT NULL
  ),
  -- Every (video frame, nearby display frame) pair, ranked by present-time gap.
  -- A LEFT JOIN keeps frames with no nearby composite (vsync_id stays NULL).
  ranked AS (
    SELECT
      vf.id,
      vf.ts,
      vf.display_id,
      vf.frame_number,
      vf.is_key_frame,
      vf.pts_us,
      df.vsync_id,
      abs(df.present_ts - vf.ts) AS gap,
      row_number() OVER (
        PARTITION BY vf.id
        ORDER BY abs(df.present_ts - vf.ts)
      ) AS rn
    FROM __intrinsic_video_frames AS vf
    LEFT JOIN display_frame AS df
      ON df.present_ts IS NOT NULL
      AND abs(df.present_ts - vf.ts) < 1000000
    WHERE vf.pts_us IS NOT NULL
  )
SELECT
  id,
  ts,
  display_id,
  frame_number,
  is_key_frame,
  pts_us,
  vsync_id,
  gap AS vsync_gap_ns
FROM ranked
WHERE rn = 1;
