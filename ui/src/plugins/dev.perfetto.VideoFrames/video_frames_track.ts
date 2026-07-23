// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import './video_frames.scss';
import m from 'mithril';
import {QuerySlot} from '../../base/query_slot';
import {materialColorScheme} from '../../components/colorizer';
import {SliceTrack} from '../../components/tracks/slice_track';
import type {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';
import {VideoFrameDetailsPanel} from './video_frame_details_panel';
import type {VideoFramePlayer} from './video_frame_player';

export function createVideoFramesTrack(
  trace: Trace,
  uri: string,
  displayId: number,
  player: VideoFramePlayer,
) {
  // dur spans each frame to the next (last frame: 0). is_config rows are
  // decoder setup, not displayable, so excluded. Frames before the first key
  // frame can't be decoded (no key frame to seed the decoder, e.g. a ring
  // buffer whose GOP start was overwritten), so start the track at the first
  // key frame.
  const src = `
    SELECT
      vf.id,
      vf.ts,
      COALESCE(LEAD(vf.ts) OVER (ORDER BY vf.ts) - vf.ts, 0) AS dur,
      0 AS depth,
      -- When the frame is aligned to a SurfaceFlinger composite, name it by
      -- that vsync id; otherwise fall back to the frame number.
      CASE
        WHEN dv.vsync_id IS NOT NULL
          THEN 'vsync ' || dv.vsync_id
        ELSE 'Frame ' || vf.frame_number
      END AS name
    FROM __intrinsic_video_frames AS vf
    LEFT JOIN android_display_video_frames AS dv USING (id)
    WHERE vf.display_id = ${displayId}
      AND COALESCE(vf.is_config, 0) = 0
      AND vf.ts >= (
        SELECT MIN(ts) FROM __intrinsic_video_frames
        WHERE display_id = ${displayId} AND is_key_frame = 1
      )
  `;

  // QuerySlot caches the decoded hover image per frame id.
  const imageSlot = new QuerySlot<string | undefined>();

  // Singleton panel so mithril patches in place instead of remounting the
  // canvas on every selection (a remount would detach the canvas and stop
  // playback, and flicker).
  const panel = new VideoFrameDetailsPanel(player);

  return SliceTrack.create({
    trace,
    uri,
    dataset: new SourceDataset({
      schema: {id: NUM, ts: LONG, dur: LONG, name: STR, depth: NUM},
      src,
    }),
    detailsPanel: () => panel,
    colorizer: (row) => materialColorScheme(row.name),
    tooltip: (data) => {
      const image = imageSlot.use({
        key: {id: data.id},
        // Keep the previous frame on screen while the next decodes, so
        // sweeping the cursor doesn't blink back to 'Loading...'.
        retainOn: ['id'],
        queryFn: () => player.decodeFrameImage(data.id),
      });
      if (image.data) {
        return [m('img.pf-video-frame-tooltip__img', {src: image.data})];
      }
      return 'Loading...';
    },
  });
}
