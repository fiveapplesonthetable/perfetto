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

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}, _testInfo) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await pth.openTraceFile('api34_startup_cold.perfetto-trace');
});

// Opens the viewer via the command (empty) and adds a searched set of counters
// via the picker.
test('open viewer via command + search-add', async () => {
  await pth.runCommand('dev.perfetto.TimeseriesViewer#open');
  await pth.waitForPerfettoIdle();
  await expect(page.getByText('Add counters to plot')).toBeVisible();
  await page.getByText('Add counters', {exact: true}).click();
  // Search, tick all matches into the pending set, then Apply commits them.
  await page.locator('.pf-tsv__picker input').first().fill('mem.rss.anon');
  await pth.waitForPerfettoIdle();
  await page.getByText('Select Filtered', {exact: true}).click();
  await page.getByText('Apply', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  await page.locator('.pf-tsv__canvas').waitFor({state: 'visible'});
  await expect(page.locator('.pf-tsv__legend .pf-tsv__chip').first()).toBeVisible();
  await pth.waitForIdleAndScreenshot('timeseries_loaded.png');
});

// The default naming is owner + metric; switching "Name by" changes the labels.
test('name by process', async () => {
  await page.locator('[title="Add counters"]').first().click();
  await page.getByText('Process', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  await page.getByText('Cancel', {exact: true}).click();
  await pth.waitForIdleAndScreenshot('timeseries_name_by_process.png');
});

test('drag to zoom', async () => {
  const canvas = page.locator('.pf-tsv__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.45, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, {steps: 12});
  await page.mouse.up();
  await pth.waitForPerfettoIdle();
  await pth.waitForIdleAndScreenshot('timeseries_zoomed.png');
});

test('reset zoom', async () => {
  await page.locator('[title="Reset zoom"]').click();
  await pth.waitForPerfettoIdle();
  await pth.waitForIdleAndScreenshot('timeseries_reset.png');
});

test('toggle log scale', async () => {
  // Scale now lives in the "Display options" (hamburger) overflow menu; its
  // items only exist in the DOM while the menu is open, so open it on demand.
  const pick = async (label: string) => {
    const item = page.getByText(label, {exact: true});
    if (!(await item.isVisible())) {
      await page.locator('[title="Display options"]').click();
    }
    await item.click();
    await pth.waitForPerfettoIdle();
  };
  await pick('Log');
  await pth.waitForIdleAndScreenshot('timeseries_log.png');
  await pick('Linear');
});

test('hide all then reveal one', async () => {
  await page.getByText('Hide all', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  // Reveal the first counter again by clicking its chip.
  await page.locator('.pf-tsv__chip-name').first().click();
  await pth.waitForPerfettoIdle();
  await pth.waitForIdleAndScreenshot('timeseries_hide_all.png');
  await page.getByText('Show all', {exact: true}).click();
  await pth.waitForPerfettoIdle();
});

test('overlay: units axis + stacked area', async () => {
  // Overlay defaults to the shared Units axis; Stacked area is in the main row.
  await page.getByText('Overlay', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  await expect(page.locator('.pf-tsv__legend .pf-tsv__chip').first()).toBeVisible();
  await expect(page.locator('.pf-tsv__canvas')).toBeVisible();
  await pth.waitForIdleAndScreenshot('timeseries_overlay_units.png');
  await page.getByText('Stacked area', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  await expect(page.locator('.pf-tsv__canvas')).toBeVisible();
  await pth.waitForIdleAndScreenshot('timeseries_overlay_stacked.png');
});

// Back in stacked mode, clicking a lane emphasises it (greys + sinks the rest)
// and marks its legend chip; a second lane joins the selection; clicking empty
// space clears it. Runs before the resize test so lane heights are uniform.
test('stacked emphasis multi-select', async () => {
  await page.getByText('Stacked', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  const emph = page.locator('.pf-tsv__chip--emphasized');
  const canvas = page.locator('.pf-tsv__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  // Emphasise the top lane, then the one below it (lane height M = 96 + gap 10).
  await page.mouse.click(box.x + box.width * 0.5, box.y + 66);
  await pth.waitForPerfettoIdle();
  expect(await emph.count()).toBe(1);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 66 + 106);
  await pth.waitForPerfettoIdle();
  expect(await emph.count()).toBe(2);
  // Clicking an emphasised (top-row) lane deselects it; the other stays on top,
  // so a second click on the same spot clears the selection.
  await page.mouse.click(box.x + box.width * 0.5, box.y + 66);
  await pth.waitForPerfettoIdle();
  expect(await emph.count()).toBe(1);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 66);
  await pth.waitForPerfettoIdle();
  expect(await emph.count()).toBe(0);
});

// Drag the first lane's bottom edge down to make just that lane taller (per-lane
// resize). The edge sits at TOP_AXIS(26) + laneHeight(96).
test('resize a single stacked lane', async () => {
  await page.getByText('Stacked', {exact: true}).click();
  await pth.waitForPerfettoIdle();
  const canvas = page.locator('.pf-tsv__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  const edgeY = box.y + 26 + 96;
  await page.mouse.move(box.x + 40, edgeY);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, edgeY + 90, {steps: 10});
  await page.mouse.up();
  await pth.waitForPerfettoIdle();
  await pth.waitForIdleAndScreenshot('timeseries_lane_resize.png');
});

// The y-range toggle: "Global" locks each axis to the counter's whole-trace
// range (zooming no longer rescales it); "Shared" puts every lane on one common
// range. Exercises the global-range fetch path and re-renders without error.
test('y-range toggle (global / shared)', async () => {
  const canvas = page.locator('.pf-tsv__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  // Range modes live in the "Display options" menu; open it on demand (items
  // only exist in the DOM while it's open).
  const pickRange = async (label: string) => {
    const item = page.getByText(label, {exact: true});
    if (!(await item.isVisible())) {
      await page.locator('[title="Display options"]').click();
    }
    await item.click();
    await pth.waitForPerfettoIdle();
  };
  await pickRange('Global');
  // Drag-select-zoom into an early slice (the wheel scrolls, it doesn't zoom);
  // in Global mode the axis stays put.
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, y, {steps: 10});
  await page.mouse.up();
  await pth.waitForPerfettoIdle();
  await pth.waitForIdleAndScreenshot('timeseries_global_range.png');
  // Shared: every lane on one common range.
  await pickRange('Shared');
  await pth.waitForIdleAndScreenshot('timeseries_shared_range.png');
  // Back to Fit + reset for a clean end state.
  await pickRange('Fit');
  await page.locator('[title="Reset zoom"]').click();
  await pth.waitForPerfettoIdle();
});
