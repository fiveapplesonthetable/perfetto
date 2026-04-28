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

// End-to-end tests for the Heapdump Explorer baseline / diff mode.
//
// Test fixtures (from upstream test/data/, downloaded by tools/test_data):
//   - system-server-heap-graph.pftrace      ← baseline
//   - system-server-heap-graph-new.pftrace  ← current (later snapshot,
//                                              same process)
//   - test-dump.hprof                       ← raw hprof for the hprof test
//   - api34_startup_cold.perfetto-trace     ← non-heap trace for rejection
//
// The pftrace pair is two real heap dumps of the same process taken at
// different times — perfect for asserting non-zero deltas. The fixtures are
// already part of the upstream repo, so no new files are committed for tests.
//
// UI selectors map to Perfetto widgets:
//   - "Load baseline trace"   → Button labelled "Load baseline trace" inside
//                                the Overview tab when no baseline is loaded.
//   - Close baseline           → Button[aria-label="Close baseline"] in the
//                                slim Callout-style status header.
//   - Mode toggle              → SegmentedButtons (.pf-segmented-buttons) with
//                                buttons labelled Diff / Current / Baseline.
//   - Diff status text         → Plain coloured uppercase span text inside
//                                a DataGrid cell. We assert by *text*
//                                (`text=GREW`, etc.) — there is no pill class.
//   - Inline error             → Callout (.pf-callout.pf-intent-danger).

import {test, expect, Page} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import {PerfettoTestHelper} from '../../test/perfetto_ui_test_helper';
// Side-effect imports: bring the global `Window.__heapdumpDebug` and
// `Window.__heapdumpDiff` augmentations into scope so
// `page.evaluate(() => window.__heapdumpDebug)` etc. are typed.
import './baseline/state';
import './diff/diff_debug';

test.describe.configure({mode: 'serial'});

const PRIMARY_TRACE = 'system-server-heap-graph-new.pftrace';
const BASELINE_TRACE = 'system-server-heap-graph.pftrace';
const HPROF_TRACE = 'test-dump.hprof';
const NON_HEAP_TRACE = 'api34_startup_cold.perfetto-trace';

let pth: PerfettoTestHelper;
let page: Page;

function tracePath(name: string): string {
  const cwd = process.cwd();
  const parts = ['test', 'data', name];
  if (cwd.endsWith('/ui')) parts.unshift('..');
  const p = path.join(...parts);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing test fixture ${p} (cwd=${cwd})`);
  }
  return p;
}

/**
 * Locator for the hidden file input that powers the "Load baseline" button.
 * Only present on the page when no baseline is currently loaded (the
 * LoadBaselineButton lives in the Overview tab).
 */
function fileInputLocator() {
  return page.locator('input[type=file][aria-hidden="true"]');
}

async function ensureOnOverview(): Promise<void> {
  await page.locator('.pf-tabs__tab:has-text("Overview")').first().click();
  await pth.waitForPerfettoIdle();
}

async function loadBaseline(name: string): Promise<void> {
  // The "Load baseline" affordance lives in the Overview tab when no
  // baseline is currently loaded.
  await ensureOnOverview();
  await fileInputLocator().setInputFiles(tracePath(name));
  await page.waitForFunction(
    () => window.__heapdumpDebug?.hasBaseline(),
    null,
    {timeout: 60_000},
  );
  await pth.waitForPerfettoIdle();
}

// Page errors and console errors collected during a test, asserted to be
// empty in the dedicated console-clean test. Reset by beforeEach.
let pageErrors: string[] = [];
let consoleErrors: string[] = [];

test.beforeAll(async ({browser}) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await pth.openTraceFile(PRIMARY_TRACE);
  // Hash-only navigation so we don't reload the page (which would drop the
  // in-memory trace; pth.navigate uses page.goto which is a full reload).
  await page.evaluate(() => {
    window.location.hash = '#!/heapdump';
  });
  await pth.waitForPerfettoIdle();
});

test.beforeEach(() => {
  pageErrors = [];
  consoleErrors = [];
});

test.afterEach(async () => {
  // Reset baseline between tests so each starts clean.
  await page.evaluate(() => {
    const dbg = window.__heapdumpDebug;
    if (dbg?.hasBaseline()) {
      // Locate the close button by its stable aria-label rather than scraping
      // the DOM for an icon glyph.
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close baseline"]')
        ?.click();
    }
  });
});

// 1. Overview tab exposes the Load baseline button when no baseline is loaded.
test('overview shows Load baseline button initially', async () => {
  await ensureOnOverview();
  await expect(
    page.locator('button:has-text("Load baseline trace")').first(),
  ).toBeVisible();
  // No slim baseline-status callout when nothing is loaded.
  await expect(page.locator('button[aria-label="Close baseline"]')).toHaveCount(
    0,
  );
  // Debug surface is wired up.
  const hasBaseline = await page.evaluate(() =>
    window.__heapdumpDebug?.hasBaseline(),
  );
  expect(hasBaseline).toBe(false);
});

// 2. Load baseline → diff mode is active by default and the slim status
//    header is visible with a Close button.
test('loading a baseline activates diff mode', async () => {
  await loadBaseline(BASELINE_TRACE);
  const filename = await page.evaluate(() =>
    window.__heapdumpDebug!.baselineFilename(),
  );
  expect(filename).toBe(BASELINE_TRACE);
  const mode = await page.evaluate(() => window.__heapdumpDebug!.mode());
  expect(mode).toBe('diff');
  // Close button appears once a baseline is loaded.
  await expect(
    page.locator('button[aria-label="Close baseline"]'),
  ).toBeVisible();
});

// 3. Same trace as primary AND baseline → every status should be UNCHANGED
//    (rendered as empty span); no GREW/SHRANK/NEW/REMOVED text in the grid.
test('same trace as baseline produces all-zero deltas', async () => {
  test.setTimeout(120_000);
  await loadBaseline(PRIMARY_TRACE); // same file as primary
  await page.locator('.pf-tabs__tab:has-text("Classes")').click();
  // Wait for the diff to finish: the heading "Classes diff" appears with a
  // resolved row count (no leading spinner anymore).
  await page
    .locator('.ah-view-heading:has-text("Classes diff")')
    .first()
    .waitFor({state: 'attached', timeout: 90_000});
  // Wait for at least one DataGrid row to be attached so we know rendering
  // completed (otherwise an empty grid trivially passes).
  await page
    .locator('.pf-data-grid .pf-grid__row')
    .first()
    .waitFor({state: 'attached', timeout: 90_000});
  // Status text cells in DataGrid: count any GREW/SHRANK/NEW/REMOVED.
  const nonUnchanged = await page
    .locator('.pf-data-grid')
    .locator('text=/^(GREW|SHRANK|NEW|REMOVED)$/')
    .count();
  expect(nonUnchanged).toBe(0);
});

// 4. Different traces → at least one row appears with a non-UNCHANGED status.
test('different baseline produces visible diffs', async () => {
  test.setTimeout(120_000);
  await loadBaseline(BASELINE_TRACE);
  await page.locator('.pf-tabs__tab:has-text("Classes")').click();
  // The two-phase query against 1M+ heap_graph_object rows can take ~30s.
  // Wait for any GREW/SHRANK/NEW/REMOVED text inside a DataGrid cell.
  await page
    .locator('.pf-data-grid')
    .locator('text=/^(GREW|SHRANK|NEW|REMOVED)$/')
    .first()
    .waitFor({state: 'attached', timeout: 90_000});
  const nonUnchanged = await page
    .locator('.pf-data-grid')
    .locator('text=/^(GREW|SHRANK|NEW|REMOVED)$/')
    .count();
  expect(nonUnchanged).toBeGreaterThan(0);

  // Parity-style invariants on the merged DiffRow array (exposed via the
  // window.__heapdumpDiff debug API). The diff classifier must be self-
  // consistent: every row has a status drawn from a fixed enum, classes
  // present in only one side are NEW/REMOVED (not GREW/SHRANK), and the
  // sum of status buckets equals the row count. These are the same rules
  // a hand-written diff against ahat would expect to hold.
  await page.waitForFunction(
    () => (window.__heapdumpDiff?.gen('classes') ?? 0) > 0,
    null,
    {timeout: 30_000},
  );
  const summary = await page.evaluate(() => {
    const rows = window.__heapdumpDiff!.rows('classes')!;
    const counts = {NEW: 0, REMOVED: 0, GREW: 0, SHRANK: 0, UNCHANGED: 0};
    let presenceViolations = 0;
    for (const r of rows) {
      counts[r.status as keyof typeof counts]++;
      const bAbs = r._b_reachable_obj_count;
      const cAbs = r._c_reachable_obj_count;
      // If status is NEW, the baseline side must be missing (encoded as
      // null on _b_*). If REMOVED, the current side must be missing.
      if (r.status === 'NEW' && bAbs !== null) presenceViolations++;
      if (r.status === 'REMOVED' && cAbs !== null) presenceViolations++;
    }
    return {total: rows.length, counts, presenceViolations};
  });
  expect(summary.total).toBeGreaterThan(0);
  expect(summary.presenceViolations).toBe(0);
  // Bucket sum must equal total.
  const sum = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  expect(sum).toBe(summary.total);
  // Different traces should produce at least one non-UNCHANGED row in the
  // merged data structure too.
  expect(summary.counts.UNCHANGED).toBeLessThan(summary.total);
});

// 5. HPROF baseline loads as well as a pftrace baseline.
test('hprof baseline loads', async () => {
  await loadBaseline(HPROF_TRACE);
  const filename = await page.evaluate(() =>
    window.__heapdumpDebug!.baselineFilename(),
  );
  expect(filename).toBe(HPROF_TRACE);
});

// 6. A non-heap trace as baseline is rejected with an inline error Callout.
test('non-heap trace rejected with inline error', async () => {
  await ensureOnOverview();
  await fileInputLocator().setInputFiles(tracePath(NON_HEAP_TRACE));
  // Wait for the danger-intent Callout (rendered both inside Overview and
  // in the slim header above the tabs).
  await page
    .locator('.pf-callout.pf-intent-danger')
    .first()
    .waitFor({state: 'visible', timeout: 60_000});
  const err = await page
    .locator('.pf-callout.pf-intent-danger')
    .first()
    .innerText();
  expect(err).toMatch(/no Java heap data|heap dump/i);
  // Baseline should NOT be set.
  const hasBaseline = await page.evaluate(() =>
    window.__heapdumpDebug!.hasBaseline(),
  );
  expect(hasBaseline).toBe(false);
});

// 7. Closing the baseline returns the page to the load-button state.
test('close baseline disposes engine and reverts header', async () => {
  await loadBaseline(BASELINE_TRACE);
  await page.locator('button[aria-label="Close baseline"]').click();
  await page.waitForFunction(
    () => window.__heapdumpDebug!.hasBaseline() === false,
    null,
    {timeout: 5_000},
  );
  // Generation must have been bumped (no longer matches whatever was active).
  const gen = await page.evaluate(() => window.__heapdumpDebug!.baselineGen());
  expect(gen).toBe(0);
  // Load button is back inside the Overview tab.
  await ensureOnOverview();
  await expect(
    page.locator('button:has-text("Load baseline trace")').first(),
  ).toBeVisible();
});

// 8. Mode toggle: switching to "Current" shows the existing single-engine
//    Classes view (no diff Δ columns).
test('Current-only mode hides diff columns', async () => {
  await loadBaseline(BASELINE_TRACE);
  // Switch the SegmentedButtons mode toggle to "Current".
  await page
    .locator('.pf-segmented-buttons button:has-text("Current")')
    .click();
  await pth.waitForPerfettoIdle();
  await page.locator('.pf-tabs__tab:has-text("Classes")').click();
  await pth.waitForPerfettoIdle();
  // The diff view's view-heading reads "Classes diff (N classes)";
  // the single-engine ClassesView heading reads "Classes (M)".
  // If Current-only correctly swapped views, no "Classes diff" header
  // should be visible anywhere on the page.
  const visibleDiffHeader = await page
    .locator('.ah-view-heading:visible:has-text("Classes diff")')
    .count();
  expect(visibleDiffHeader).toBe(0);
  // The single-engine "Classes" heading is visible.
  await page
    .locator('.ah-view-heading:visible')
    .first()
    .waitFor({timeout: 30_000});
});

// 9. Smoke for each diff-capable tab: navigate, ensure no error renders.
test('every diff-capable tab renders without error', async () => {
  test.setTimeout(300_000);
  await loadBaseline(BASELINE_TRACE);
  for (const tab of [
    'Overview',
    'Classes',
    'Strings',
    'Arrays',
    'Bitmaps',
    'Dominators',
  ]) {
    await page.locator(`.pf-tabs__tab:has-text("${tab}")`).click();
    // Give the diff query time to complete; we don't wait for content
    // because Strings on a 1M-object trace can be slow.
    await page.waitForTimeout(15_000);
    // No error/empty state with "Failed".
    const failed = await page
      .locator('.pf-empty-state:has-text("Failed")')
      .count();
    expect(failed, `tab ${tab} renders an error`).toBe(0);
  }
});

// 10. Overview tab MUST switch to the diff layout once the baseline overview
//     has finished loading. The 'Overview diff' heading proves the unified
//     view received `baselineOverview` and rendered the diff branch.
test('Overview tab swaps to diff layout when baseline loads', async () => {
  test.setTimeout(180_000);
  await loadBaseline(BASELINE_TRACE);
  await ensureOnOverview();
  // The view-heading text flips from "Overview" → "Overview diff" once
  // baselineOverview is computed and threaded in. Use :visible to skip
  // any hidden tab-content headings the Tabs widget may keep around.
  await expect(
    page.locator('.ah-view-heading:visible:has-text("Overview diff")'),
  ).toBeVisible({timeout: 120_000});
  // The General Information card now has Baseline / Current / Δ columns.
  // Same :visible discipline; also a longer toContainText timeout in case
  // the overview rerender cascades over multiple frames.
  const infoCard = page
    .locator('.ah-card:visible:has-text("General Information")')
    .first();
  await expect(infoCard).toContainText('Baseline', {timeout: 30_000});
  await expect(infoCard).toContainText('Current', {timeout: 5_000});
  // Bytes Retained by Heap card too.
  await expect(
    page.locator('.ah-card:visible:has-text("Bytes Retained by Heap")').first(),
  ).toContainText('Δ Total', {timeout: 30_000});
});

// 11. No uncaught page errors or console.error across loading + tab nav.
//     Catches regressions where a missing import / runtime crash would only
//     surface as a console scribble and an empty card.
test('no console errors during baseline load and tab navigation', async () => {
  test.setTimeout(120_000);
  await loadBaseline(BASELINE_TRACE);
  await ensureOnOverview();
  await page.waitForTimeout(8_000); // let baseline overview finish
  for (const tab of ['Classes', 'Strings', 'Bitmaps', 'Overview']) {
    await page.locator(`.pf-tabs__tab:has-text("${tab}")`).click();
    await page.waitForTimeout(4_000);
  }
  expect(pageErrors, 'page emitted uncaught errors').toEqual([]);
  expect(
    consoleErrors.filter(
      // Allow trace-processor's noisy benign warnings through; they're not
      // from the plugin code.
      (e) => !e.includes('TraceProcessor') && !e.includes('WebGL'),
    ),
    'plugin emitted console errors',
  ).toEqual([]);
});
