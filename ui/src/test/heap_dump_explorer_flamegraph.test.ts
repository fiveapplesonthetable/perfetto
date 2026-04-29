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

import {test, expect, Page} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await pth.openTraceFile('system-server-heap-graph-new.pftrace');
});

async function gotoHde(subpage: string = ''): Promise<void> {
  // Navigate via the hash without a full page reload so the loaded trace
  // (set up in beforeAll) is preserved.
  const hash = '#!/heapdump' + (subpage ? '/' + subpage : '');
  await page.evaluate((h) => {
    window.location.hash = h.slice(1);
  }, hash);
  await pth.waitForPerfettoIdle();
}

async function getHash(): Promise<string> {
  return page.evaluate(() => window.location.hash);
}

test('flamegraph tab is present and renders', async () => {
  await gotoHde();
  const flamegraphTab = page.locator('.pf-tabs__tab', {hasText: 'Flamegraph'});
  await expect(flamegraphTab).toBeVisible({timeout: 15_000});
  await flamegraphTab.click();
  await pth.waitForPerfettoIdle();
  // The pf-flamegraph container is rendered inside the now-open Gate.
  await expect(
    page.locator('.ah-flamegraph-view .pf-flamegraph').first(),
  ).toBeVisible({timeout: 15_000});
});

test('flamegraph URL roundtrips through the hash', async () => {
  await gotoHde('flamegraph');
  await pth.waitForPerfettoIdle();
  const hash = await getHash();
  expect(hash).toContain('flamegraph');
  await expect(
    page.locator('.ah-flamegraph-view .pf-flamegraph').first(),
  ).toBeVisible({timeout: 15_000});
});

test('flamegraph state survives a tab switch', async () => {
  // Load flamegraph first.
  await gotoHde('flamegraph');
  await pth.waitForPerfettoIdle();
  // Wait for the metric selector (filled once metrics are loaded).
  const metricSelect = page
    .locator('.ah-flamegraph-view .pf-flamegraph select')
    .first();
  await expect(metricSelect).toBeVisible({timeout: 15_000});
  // Pick the Object Count metric so we have something to verify.
  await metricSelect.selectOption({label: 'Object Count'});
  await pth.waitForPerfettoIdle();

  // Switch away to Overview, then back to Flamegraph.
  await page.locator('.pf-tabs__tab', {hasText: 'Overview'}).click();
  await pth.waitForPerfettoIdle();
  await page.locator('.pf-tabs__tab', {hasText: 'Flamegraph'}).click();
  await pth.waitForPerfettoIdle();

  // Selected metric is still Object Count.
  // The select value uses the option text, so check for substring.
  await expect(metricSelect).toHaveJSProperty('value', 'Object Count');
});

test('flamegraph?cls=... seeds a SHOW_FROM_FRAME filter (idempotent across redraws)', async () => {
  const cls = 'java.lang.String';

  await gotoHde('flamegraph_' + encodeURIComponent(cls));
  await pth.waitForPerfettoIdle();

  // The route is bookmarkable: the cls token stays in the URL path.
  const sub = await page.evaluate(() => window.location.hash);
  expect(sub).toContain('flamegraph_' + encodeURIComponent('java.lang.String'));

  // The filter bar is rendered with a chip referencing the class name.
  const filterBar = page
    .locator('.ah-flamegraph-view .pf-flamegraph-filter-label')
    .first();
  await expect(filterBar).toBeVisible({timeout: 15_000});
  await expect(
    page.locator('.ah-flamegraph-view .pf-flamegraph').first(),
  ).toContainText('String', {timeout: 5_000});

  // Idempotent: switching tabs and coming back does not re-add the filter
  // chip — the count of SHOW_FROM_FRAME chips stays at 1.
  const countShowFromChips = async () =>
    page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll(
            '.ah-flamegraph-view .pf-flamegraph .pf-flamegraph-filter-bar *',
          ),
        ).filter((el) => /from /i.test(el.textContent ?? '')).length,
    );

  const firstCount = await countShowFromChips();

  await page.locator('.pf-tabs__tab', {hasText: 'Overview'}).click();
  await pth.waitForPerfettoIdle();
  await page.locator('.pf-tabs__tab', {hasText: 'Flamegraph'}).click();
  await pth.waitForPerfettoIdle();

  const secondCount = await countShowFromChips();
  expect(secondCount).toEqual(firstCount);
});

test('Open in Flamegraph button on object view filters to that class', async () => {
  // Use the engine to find an object id that exists in the active dump.
  const objId = await page.evaluate(async () => {
    const engine = self.app.trace!.engine;
    const r = await engine.query(
      'select id from heap_graph_object order by self_size desc limit 1',
    );
    const it = r.iter({id: Number()});
    return it.valid() ? Number(it.id) : 0;
  });
  expect(objId).toBeGreaterThan(0);

  await gotoHde('object_0x' + objId.toString(16));
  await pth.waitForPerfettoIdle();

  // The "Open in Flamegraph" button is in the action row.
  const btn = page.getByRole('button', {name: 'Open in Flamegraph'});
  await expect(btn).toBeVisible({timeout: 15_000});
  await btn.click();
  await pth.waitForPerfettoIdle();

  // We should now be on the flamegraph subpage with cls encoded in path.
  const hash = await getHash();
  expect(hash).toMatch(/heapdump\/flamegraph(_|\?|$)/);

  // The flamegraph view is open with a filter chip from SHOW_FROM_FRAME.
  await expect(
    page.locator('.ah-flamegraph-view .pf-flamegraph-filter-label').first(),
  ).toBeVisible({timeout: 15_000});
});
