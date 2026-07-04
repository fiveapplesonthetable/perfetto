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

import {test, expect, type Page} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

let pth: PerfettoTestHelper;
let page: Page;

// A trace with android.surfaceflinger.layers keeps redrawing (Winscope tracks),
// so the standard waitForPerfettoIdle never settles. Load the trace manually and
// poll for the trace object instead.
test.beforeAll(async ({browser}, testInfo) => {
  testInfo.setTimeout(180000);
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await page.goto('/?testing=1&enablePlugins=dev.perfetto.VideoFrames');
  const file = await page.waitForSelector('input.trace_file', {
    state: 'attached',
  });
  await file.setInputFiles(
    pth.getTestTracePath('video_frame_callstacks.perfetto-trace'),
  );
  await page.waitForFunction(() => self.app?.trace !== undefined, undefined, {
    timeout: 120000,
  });
  await page.waitForTimeout(4000);
});

test.afterAll(async () => await page.close());

const FRAME = {id: 65, displayId: 0};

test('video_frame_buffers_grid', async () => {
  await page.evaluate((frame) => {
    self.app.trace!.selection.selectTrackEvent(
      `/video_frames/${frame.displayId}`,
      frame.id,
    );
  }, FRAME);
  await page.locator('.pf-data-grid').waitFor();
  await page.getByText('com.android.deskclock').first().waitFor();
  await page.waitForTimeout(2000);
  await page.mouse.move(0, 0);
  await expect
    .soft(page)
    .toHaveScreenshot('video_frame_buffers_grid.png', {animations: 'disabled'});
});

test('layer_tracks_registered', async () => {
  const count = await page.evaluate(
    () =>
      self.app
        .trace!.tracks.getAllTracks()
        .filter((t) => t.uri.startsWith('/video_frame_layers/')).length,
  );
  expect(count).toBeGreaterThan(0);
});

test('buffer_slice_details', async () => {
  // Select a "changed" buffer slice for an app layer, whose details panel shows
  // the full buffer info plus the "Jump to doFrame" button.
  await page.evaluate(async () => {
    const trace = self.app.trace!;
    const result = await trace.engine.query(
      `select id, track_idx as ti from _video_frame_buffer_slices
       where changed = 1 and track_name glob 'com.android.deskclock*'
       order by id limit 1`,
    );
    const row = result.firstRow({id: 0, ti: 0});
    trace.selection.selectTrackEvent(
      `/video_frame_layers/changed/${row.ti}`,
      row.id,
    );
  });
  await page.getByRole('button', {name: 'Jump to doFrame'}).waitFor();
  await page.waitForTimeout(2000);
  await page.mouse.move(0, 0);
  await expect
    .soft(page)
    .toHaveScreenshot('buffer_slice_details.png', {animations: 'disabled'});
});

test('jump_to_doframe_is_exact', async () => {
  // "Jump to doFrame" must land on the exact doFrame that produced the buffer:
  // video -> the SurfaceFlinger composite presented before it -> the app's
  // surface frame in that composite (keyed by display frame token) -> doFrame.
  // Compute it independently for a changed slice, click, assert the match.
  const {ti, id, expected} = await page.evaluate(async () => {
    const trace = self.app.trace!;
    const r = await trace.engine.query(`
      with comp as (
        select cast(str_split(c.name, ' ', 1) as int) as token, c.ts + c.dur as done
        from slice c
        join thread_track tt on tt.id = c.track_id
        join thread t on t.utid = tt.utid
        join process p on p.upid = t.upid
        where p.name glob '*surfaceflinger*' and c.name glob 'composite *'
      ),
      rows as (
        select b.id, b.track_idx as ti,
          (select ds.id from actual_frame_timeline_slice sf
             join track sft on sft.id = sf.track_id
             join slice ds
               on ds.name = 'Choreographer#doFrame ' ||
                            extract_arg(sf.arg_set_id, 'Surface frame token')
             join thread_track dtt on dtt.id = ds.track_id
             join thread dth
               on dth.utid = dtt.utid
              and dth.upid = extract_arg(sft.dimension_arg_set_id, 'upid')
           where extract_arg(sf.arg_set_id, 'Is Buffer?') = 'Yes'
             and replace(extract_arg(sf.arg_set_id, 'Layer name'), 'TX - ', '')
                 glob b.track_name || '#*'
             and cast(extract_arg(sf.arg_set_id, 'Display frame token') as int) =
                 (select token from comp where done <= b.ts order by done desc limit 1)
           limit 1) as doframe
        from _video_frame_buffer_slices b
        where b.changed = 1 and b.track_name glob 'com.android.deskclock*'
      )
      select id, ti, doframe from rows where doframe is not null order by id limit 1`);
    const row = r.firstRow({id: 0, ti: 0, doframe: 0});
    trace.selection.selectTrackEvent(
      `/video_frame_layers/changed/${row.ti}`,
      row.id,
    );
    return {ti: row.ti, id: row.id, expected: row.doframe};
  });
  expect(ti).toBeGreaterThanOrEqual(0);
  expect(id).toBeGreaterThan(0);
  await page.getByRole('button', {name: 'Jump to doFrame'}).click();
  await page.waitForTimeout(1000);
  const landedOn = await page.evaluate(() => {
    const sel = self.app.trace!.selection.selection as {
      kind: string;
      eventId?: number;
    };
    return sel.kind === 'track_event' ? sel.eventId : undefined;
  });
  expect(landedOn).toBe(expected);
});
