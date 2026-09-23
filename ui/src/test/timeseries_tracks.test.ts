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

import {expect, test, type Locator, type Page} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial', timeout: 180_000});

let pth: PerfettoTestHelper;
let page: Page;
const pageErrors: string[] = [];
let counterCount = 0;

// This trace has a "GPU Memory" counter for the device and for each of
// several processes.
const TRACE = 'api34_startup_cold.perfetto-trace';
const TRACK = 'GPU memory by process';

const timeline = () => page.locator('.pf-timeline-page__timeline');
const tooltipRows = () => page.locator('.pf-chart-svg__tooltip-row');

async function addTrackFromDialog(search: string, name: string) {
  await pth.runCommand('dev.perfetto.AddTimeseriesTrack');
  const dialog = page.locator('.pf-timeseries-track-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.pf-search-box input').fill(search);
  await dialog.getByRole('button', {name: 'Select Filtered'}).click();
  await dialog.locator('input[placeholder]').last().fill(name);
  await page.getByRole('button', {name: 'Add track'}).click();
  await pth.waitForPerfettoIdle();
}

async function openTrackMenu(track: Locator) {
  await track.locator('.pf-track__shell').first().hover();
  await track.locator('button[title="Track options"]').first().click();
  await pth.waitForPerfettoIdle();
}

async function clickMenuItem(label: string | RegExp) {
  await page
    .locator('.pf-popup-content')
    .last()
    .locator('.pf-menu-item', {hasText: label})
    .first()
    .click();
  await pth.waitForPerfettoIdle();
}

async function closeMenus() {
  await pth.resetFocus();
  await page.mouse.move(0, 0);
  await pth.waitForPerfettoIdle();
  await expect(page.locator('.pf-popup-content')).toHaveCount(0);
}

async function chooseSetting(
  track: Locator,
  menu: string | RegExp,
  option: string | RegExp,
) {
  await openTrackMenu(track);
  await clickMenuItem(menu);
  await clickMenuItem(option);
  await closeMenus();
}

let rows = false;

// Lines and Stacked are Layout options; rows is the track's expand button.
async function showLayout(track: Locator, layout: string) {
  if ((layout === 'Rows') !== rows) {
    await track.locator('.pf-track__shell').first().hover();
    await track
      .locator('.pf-track__shell button', {hasText: /unfold_(more|less)/})
      .first()
      .click();
    await pth.waitForPerfettoIdle();
    rows = !rows;
  }
  if (layout !== 'Rows') {
    await chooseSetting(track, /^Layout/, layout);
  }
}

async function toggleSetting(track: Locator, label: string) {
  await openTrackMenu(track);
  await clickMenuItem(label);
  await closeMenus();
}

async function canvasBox(track: Locator) {
  const box = await track.locator('.pf-track__canvas').first().boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function dragResizeGrip(track: Locator, dy: number) {
  // Tracks scrolled out of view render without their grip.
  await track.scrollIntoViewIfNeeded();
  await pth.waitForPerfettoIdle();
  const handle = track.locator('.pf-resize-handle').first();
  await handle.scrollIntoViewIfNeeded();
  const grip = await handle.boundingBox();
  expect(grip).not.toBeNull();
  const x = grip!.x + grip!.width / 2;
  await page.mouse.move(x, grip!.y);
  await page.mouse.down();
  await page.mouse.move(x, grip!.y + dy, {steps: 10});
  await page.mouse.up();
  await pth.waitForPerfettoIdle();
}

// Moves down a column of the track, noting the tooltip's rows at each step.
async function scanTooltips(track: Locator, xFraction: number, stepPx = 5) {
  const box = await canvasBox(track);
  const x = box.x + box.width * xFraction;
  const rows: {y: number; names: string[]}[] = [];
  for (let y = 16; y < box.height - 2; y += stepPx) {
    await page.mouse.move(x, box.y + y);
    await pth.waitForPerfettoIdle();
    const names = await tooltipRows()
      .locator('.pf-chart-svg__tooltip-name')
      .allTextContents();
    rows.push({y, names});
  }
  await page.mouse.move(0, 0);
  return rows;
}

function pinnedTrackNames(): Promise<string[]> {
  return page.evaluate(
    () =>
      self.app.trace?.currentWorkspace.pinnedTracksNode.children.map(
        (node) => node.name,
      ) ?? [],
  );
}

async function expectHealthy() {
  await expect(page.locator('.pf-track__canvas--error')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
}

test.beforeAll(async ({browser}) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  pth = new PerfettoTestHelper(page);
  await pth.openTraceFile(TRACE);
});

test('dialog: search, pick, label and name', async () => {
  await pth.runCommand('dev.perfetto.AddTimeseriesTrack');
  const dialog = page.locator('.pf-timeseries-track-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.pf-search-box input').fill('GPU Memory');
  await dialog.getByRole('button', {name: 'Select Filtered'}).click();
  await pth.waitForPerfettoIdle();
  counterCount = await dialog
    .locator('.pf-multiselect-container')
    .first()
    .locator('.pf-multiselect-item')
    .count();
  expect(counterCount).toBeGreaterThan(5);

  // The counters share a name, so lines are labelled by process and the track
  // is named after the counter.
  await expect(dialog.locator('.pf-radio-group .pf-active')).toHaveText(
    'Process or thread',
  );
  await expect(dialog.locator('input[placeholder="GPU Memory"]')).toHaveCount(
    1,
  );

  // Long names are clipped rather than overflowing sideways.
  const overflow = await dialog
    .locator('.pf-list')
    .evaluate((e) => e.scrollWidth - e.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect
    .soft(page.locator('.pf-modal-dialog'))
    .toHaveScreenshot('dialog.png');

  await page.getByRole('button', {name: 'Cancel'}).click();
  await pth.waitForPerfettoIdle();
});

test('add a track from the dialog', async () => {
  await addTrackFromDialog('GPU Memory', TRACK);
  const track = pth.locateTrack(TRACK);
  await expect(track).toHaveCount(1);
  await pth.waitForIdleAndScreenshot('lines.png', {locator: track});
  await expectHealthy();
});

test('lines: hovering a line focuses it, empty space does not', async () => {
  const track = pth.locateTrack(TRACK);
  const rows = await scanTooltips(track, 0.8);
  const onLine = rows.filter((r) => r.names.length === 2);
  const offLine = rows.filter((r) => r.names.length === 1);
  expect(onLine.length).toBeGreaterThan(0);
  expect(offLine.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.names.at(-1)).toBe('Total');
  }

  const box = await canvasBox(track);
  await page.mouse.move(box.x + box.width * 0.8, box.y + onLine[0].y);
  await pth.waitForPerfettoIdle();
  await expect(tooltipRows()).toHaveCount(2);
  await expect.soft(timeline()).toHaveScreenshot('lines hover.png');
  await page.mouse.move(0, 0);
});

test('legend: clicking a chip hides and restores its counter', async () => {
  const track = pth.locateTrack(TRACK);
  const box = await canvasBox(track);
  await page.mouse.click(box.x + 20, box.y + 7);
  await pth.waitForIdleAndScreenshot('chip hidden.png', {locator: track});

  await page.mouse.click(box.x + 20, box.y + 7);
  await pth.waitForIdleAndScreenshot('lines.png', {locator: track});
});

test('legend: hovering a chip focuses its counter', async () => {
  const track = pth.locateTrack(TRACK);
  const box = await canvasBox(track);
  await page.mouse.move(box.x + 20, box.y + 7);
  await pth.waitForPerfettoIdle();
  await expect(tooltipRows()).toHaveCount(2);
  await expect.soft(timeline()).toHaveScreenshot('chip hover.png');
  await page.mouse.move(0, 0);
});

test('counters menu: toggle one, then show all', async () => {
  const track = pth.locateTrack(TRACK);
  await openTrackMenu(track);
  await clickMenuItem('Counters');
  const menu = page.locator('.pf-popup-content').last();
  await expect.soft(menu).toHaveScreenshot('counters menu.png');

  const icon = menu.locator('.pf-menu-item').nth(2).locator('i').first();
  await expect(icon).toHaveText('check_box');
  await menu.locator('.pf-menu-item').nth(2).click();
  await pth.waitForPerfettoIdle();
  await expect(icon).toHaveText('check_box_outline_blank');
  await clickMenuItem('Show all');
  await expect(icon).toHaveText('check_box');
  await closeMenus();
  await pth.waitForIdleAndScreenshot('lines.png', {locator: track});
});

test('stacked: hovering inside a band focuses that counter', async () => {
  const track = pth.locateTrack(TRACK);
  await showLayout(track, 'Stacked');
  await pth.waitForIdleAndScreenshot('stacked.png', {locator: track});

  const rows = await scanTooltips(track, 0.8);
  const inBand = rows.filter((r) => r.names.length === 2);
  expect(inBand.length).toBeGreaterThan(0);
  expect(new Set(inBand.map((r) => r.names[0])).size).toBeGreaterThan(1);

  const box = await canvasBox(track);
  await page.mouse.move(box.x + box.width * 0.8, box.y + inBand.at(-1)!.y);
  await pth.waitForPerfettoIdle();
  await expect.soft(timeline()).toHaveScreenshot('stacked hover.png');
  await page.mouse.move(0, 0);
});

test('rows: a row per counter, hover picks the row', async () => {
  const track = pth.locateTrack(TRACK);
  await showLayout(track, 'Rows');
  await chooseSetting(track, /^Size/, 'Small (1x)');
  await track.evaluate((e) => e.scrollIntoView({block: 'start'}));
  const box = await canvasBox(track);
  expect(box.height).toBe(14 + 40 * counterCount);
  await pth.waitForIdleAndScreenshot('rows.png', {locator: timeline()});

  // Each 40px row under the legend picks out its own counter.
  const names: string[] = [];
  for (let row = 0; row < 5; row++) {
    await page.mouse.move(box.x + box.width * 0.8, box.y + 34 + 40 * row);
    await pth.waitForPerfettoIdle();
    await expect(tooltipRows()).toHaveCount(2);
    names.push(await tooltipRows().first().innerText());
  }
  expect(new Set(names).size).toBe(5);
  await expect.soft(timeline()).toHaveScreenshot('rows hover.png');
  await page.mouse.move(0, 0);
});

test('rows: hiding a counter removes its row', async () => {
  const track = pth.locateTrack(TRACK);
  await track.evaluate((e) => e.scrollIntoView({block: 'start'}));
  const before = await canvasBox(track);
  await page.mouse.click(before.x + 20, before.y + 7);
  await pth.waitForPerfettoIdle();
  expect((await canvasBox(track)).height).toBeLessThan(before.height);

  await page.mouse.click(before.x + 20, before.y + 7);
  await pth.waitForPerfettoIdle();
  expect((await canvasBox(track)).height).toBe(before.height);
});

for (const [layout, size] of [
  ['Rows', 'Small (1x)'],
  ['Stacked', 'Large (4x)'],
  ['Lines', 'Large (4x)'],
]) {
  test(`resize by dragging: ${layout}`, async () => {
    const track = pth.locateTrack(TRACK);
    await showLayout(track, layout);
    await chooseSetting(track, /^Size/, size);

    // The edge follows the pointer.
    const start = (await track.boundingBox())!.height;
    await dragResizeGrip(track, 120);
    const grown = (await track.boundingBox())!.height;
    expect(Math.abs(grown - start - 120)).toBeLessThanOrEqual(3);
    await pth.waitForIdleAndScreenshot(`resized ${layout}.png`, {
      locator: track,
    });

    // And stops at a minimum height rather than collapsing.
    await dragResizeGrip(track, -3000);
    expect((await track.boundingBox())!.height).toBeGreaterThan(30);
    await expectHealthy();

    // The size menu takes over from a drag.
    await chooseSetting(track, /^Size/, size);
    expect((await track.boundingBox())!.height).toBe(start);
  });
}

test('every mode and display renders in every layout', async () => {
  test.setTimeout(1_200_000);
  const track = pth.locateTrack(TRACK);
  await chooseSetting(track, /^Size/, 'Small (1x)');
  for (const layout of ['Lines', 'Stacked', 'Rows']) {
    await showLayout(track, layout);
    for (const mode of ['Value', 'Delta', 'Rate']) {
      await chooseSetting(track, /^Mode/, mode);
      for (const display of ['Zero-based', 'Min/Max', 'Log']) {
        await chooseSetting(track, /^Display/, display);
        await scanTooltips(track, 0.5, 50);
        await expectHealthy();
      }
    }
    await chooseSetting(track, /^Mode/, 'Value');
    await chooseSetting(track, /^Display/, 'Zero-based');
    await toggleSetting(track, 'Zoom on scroll');
    await pth.waitForIdleAndScreenshot(`zoom on scroll ${layout}.png`, {
      locator: track,
    });
    await toggleSetting(track, 'Zoom on scroll');
  }
  await showLayout(track, 'Lines');
  await chooseSetting(track, /^Size/, 'Large (4x)');
});

test('a long legend scrolls sideways', async () => {
  await addTrackFromDialog('power.rails', 'Power rails');
  const track = pth.locateTrack('Power rails');
  await expect(track).toHaveCount(1);
  await pth.waitForIdleAndScreenshot('long legend.png', {locator: track});

  const box = await canvasBox(track);
  const legend = {x: box.x + box.width / 2, y: box.y + 7};
  await page.mouse.move(legend.x, legend.y);
  await page.mouse.wheel(400, 0);
  await pth.waitForIdleAndScreenshot('long legend scrolled.png', {
    locator: track,
  });

  // Vertical wheeling over the legend is left to the timeline.
  await page.mouse.move(legend.x, legend.y);
  await page.mouse.wheel(0, 100);
  await pth.waitForIdleAndScreenshot('long legend scrolled.png', {
    locator: track,
  });

  // Shift turns a vertical wheel into a sideways one.
  await page.mouse.move(legend.x, legend.y);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Shift');
  await pth.waitForIdleAndScreenshot('long legend.png', {locator: track});
  await expectHealthy();
});

test('add from selected counter tracks', async () => {
  const names = await pinnedTrackNames();
  await pth.runCommand('dev.perfetto.AddTimeseriesTrackFromSelection');
  await pth.waitForPerfettoIdle();
  expect(await pinnedTrackNames()).toEqual(names);

  const box = await canvasBox(pth.locateTrack(TRACK));
  await page.mouse.move(box.x + box.width * 0.2, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 60, {steps: 8});
  await page.mouse.up();
  await pth.waitForPerfettoIdle();

  await pth.runCommand('dev.perfetto.AddTimeseriesTrackFromSelection');
  await pth.waitForPerfettoIdle();
  const after = await pinnedTrackNames();
  expect(after).toEqual([...names, 'GPU Memory']);
  await pth.waitForIdleAndScreenshot('from selection.png', {
    locator: pth.locateTrack('GPU Memory'),
  });
  await expectHealthy();
});

test('the dialog starts from the selected counters', async () => {
  await pth.runCommand('dev.perfetto.AddTimeseriesTrack');
  const dialog = page.locator('.pf-timeseries-track-dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('.pf-multiselect-header', {hasText: 'Selected'}),
  ).toHaveCount(1);
  await page.getByRole('button', {name: 'Cancel'}).click();
  await pth.waitForPerfettoIdle();
  await page.keyboard.press('Escape');
  await pth.waitForPerfettoIdle();
});

test('copy to counter tracks', async () => {
  const track = pth.locateTrack(TRACK);
  const before = await pinnedTrackNames();
  const index = before.indexOf(TRACK);
  await openTrackMenu(track);
  await clickMenuItem('Copy to counter tracks');
  await closeMenus();

  // A group named after the chart, holding each counter's own track, lands
  // right after it; the chart stays.
  const after = await pinnedTrackNames();
  expect(after).toEqual([
    ...before.slice(0, index + 1),
    TRACK,
    ...before.slice(index + 1),
  ]);
  const pinned = page.locator('.pf-timeline-page__pinned-track-tree');
  const group = pinned.locator(`.pf-track[ref="${TRACK}"]`).nth(1);
  await expect(group.locator('.pf-track__children > .pf-track')).toHaveCount(
    counterCount,
  );
  await group.evaluate((e) => e.scrollIntoView({block: 'start'}));
  await pth.waitForIdleAndScreenshot('copied.png', {locator: timeline()});
  await expectHealthy();
});

test('the copied counter tracks resize too', async () => {
  const child = page
    .locator('.pf-timeline-page__pinned-track-tree')
    .locator(`.pf-track[ref="${TRACK}"]`)
    .nth(1)
    .locator('.pf-track__children > .pf-track')
    .first();
  const before = (await child.boundingBox())!.height;
  await dragResizeGrip(child, 60);
  const after = (await child.boundingBox())!.height;
  expect(Math.abs(after - before - 60)).toBeLessThanOrEqual(3);
  await expectHealthy();
});
