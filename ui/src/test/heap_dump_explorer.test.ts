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

import {test, Page, Locator, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

// Exercises the com.android.HeapDumpExplorer plugin to guard against
// regressions from the global-state -> session encapsulation refactor.
// Assertions are on observable DOM/URL state — no screenshot snapshots.

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

const HEAP_TRACE_A = 'system-server-heap-graph.pftrace';
const HEAP_TRACE_B = 'heap_graph_object_for_benchmarks.pftrace';

const FIXED_TABS = [
  ['Overview', ''],
  ['Classes', 'classes'],
  ['Objects', 'objects'],
  ['Dominators', 'dominators'],
  ['Bitmaps', 'bitmaps'],
  ['Strings', 'strings'],
  ['Arrays', 'arrays'],
] as const;

/** Locate a tab inside the heap-dump page by its visible title. */
function tabByTitle(title: string): Locator {
  return page
    .locator('.ah-page .pf-tabs__tab')
    .filter({has: page.locator(`.pf-tabs__tab-title >> text="${title}"`)});
}

async function gotoHeapdumpAndWait() {
  await pth.navigate('#!/heapdump');
  await pth.waitForPerfettoIdle();
  // Wait for the explorer's main shell to render — confirms the
  // session was created (otherwise we'd see only the EmptyState).
  await page.locator('.ah-page main').waitFor({state: 'attached'});
  // Wait for the tabs widget — guards against still-loading-overview.
  await page.locator('.ah-page .pf-tabs').waitFor({state: 'visible'});
}

async function clickTab(title: string) {
  await tabByTitle(title).first().click();
  await pth.waitForPerfettoIdle();
}

/**
 * Returns the first visible, non-placeholder object link inside the
 * heap-dump page. The DataGrid pre-renders hidden rows whose link text
 * is "null"; we skip those.
 */
function firstObjectLink(): Locator {
  return page
    .locator('.ah-page .ah-link:visible')
    .filter({hasNotText: /^null$/})
    .first();
}

async function getHash(): Promise<string> {
  return page.evaluate(() => window.location.hash);
}

test.beforeAll(async ({browser}) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await pth.openTraceFile(HEAP_TRACE_A);
});

test('heap dump explorer renders for a heap-graph trace', async () => {
  await gotoHeapdumpAndWait();
  for (const [title] of FIXED_TABS) {
    await expect(tabByTitle(title)).toBeVisible();
  }
});

test('clicking each fixed tab updates the URL hash', async () => {
  for (const [title, hashSuffix] of FIXED_TABS) {
    await clickTab(title);
    const hash = await getHash();
    if (hashSuffix === '') {
      // Overview = bare /heapdump, possibly followed by query params
      // (Perfetto re-injects the trace cache key after a hash change).
      expect(hash).toMatch(/^#!\/heapdump(\?|\/?$)/);
    } else {
      expect(hash).toContain(`#!/heapdump/${hashSuffix}`);
    }
  }
});

test('opening an instance tab and closing it returns to fixed tabs', async () => {
  await clickTab('Objects');
  // Click the first object link; this should open a closable instance tab.
  const firstLink = firstObjectLink();
  await firstLink.waitFor({state: 'visible'});
  await firstLink.click();
  await pth.waitForPerfettoIdle();

  // The instance tab is the first tab whose key starts with 'inst-'.
  // Tabs are rendered with no key attribute, so look for the unique
  // close button on a tab — fixed tabs don't have one.
  const closableTabs = page.locator('.ah-page .pf-tabs__tab .pf-button--minimal');
  await expect(closableTabs.first()).toBeVisible();
  expect(await getHash()).toContain('/object_');

  // Close it and check we're back at overview.
  await closableTabs.first().click();
  await pth.waitForPerfettoIdle();
  expect(await getHash()).toMatch(/^#!\/heapdump(\?|\/?$)/);
});

test('opening the same object twice focuses the existing tab', async () => {
  await clickTab('Objects');
  const firstLink = firstObjectLink();
  await firstLink.waitFor({state: 'visible'});
  const linkText = (await firstLink.textContent()) ?? '';
  await firstLink.click();
  await pth.waitForPerfettoIdle();
  // Now go back to Objects and re-click the same link.
  await clickTab('Objects');
  const sameLink = firstObjectLink();
  await sameLink.waitFor({state: 'visible'});
  await sameLink.click();
  await pth.waitForPerfettoIdle();
  // Should still be a single instance tab (no duplicate).
  const closableTabs = page.locator('.ah-page .pf-tabs__tab .pf-button--minimal');
  await expect(closableTabs).toHaveCount(1);
  // And the tab title should match the link's truncated label.
  const tabTitle = await page
    .locator('.ah-page .pf-tabs__tab .pf-tabs__tab-title')
    .last()
    .textContent();
  // Mithril shows the truncated form (max 30 + ellipsis), but the
  // truncation prefix should still be present in the link text.
  expect(linkText).toContain((tabTitle ?? '').replace(/…$/, ''));
  // Clean up.
  await closableTabs.first().click();
  await pth.waitForPerfettoIdle();
});

test('back/forward across hash changes restores the right tab', async () => {
  await clickTab('Classes');
  await clickTab('Strings');
  await page.goBack();
  await pth.waitForPerfettoIdle();
  expect(await getHash()).toContain('#!/heapdump/classes');
  await page.goForward();
  await pth.waitForPerfettoIdle();
  expect(await getHash()).toContain('#!/heapdump/strings');
  await clickTab('Overview');
});

test('loading a different trace replaces the explorer state', async () => {
  // Open an instance tab on trace A.
  await clickTab('Objects');
  const firstLink = firstObjectLink();
  await firstLink.waitFor({state: 'visible'});
  await firstLink.click();
  await pth.waitForPerfettoIdle();
  await expect(
    page.locator('.ah-page .pf-tabs__tab .pf-button--minimal').first(),
  ).toBeVisible();

  // Switch to trace B.
  await pth.openTraceFile(HEAP_TRACE_B);
  await gotoHeapdumpAndWait();

  // No closable tabs survive across the trace boundary.
  await expect(
    page.locator('.ah-page .pf-tabs__tab .pf-button--minimal'),
  ).toHaveCount(0);

  // The seven fixed tabs are still there.
  for (const [title] of FIXED_TABS) {
    await expect(tabByTitle(title)).toBeVisible();
  }
});

test('returning to a non-heap-graph trace shows the empty state', async () => {
  await pth.openTraceFile('api34_startup_cold.perfetto-trace');
  await pth.navigate('#!/heapdump');
  await pth.waitForPerfettoIdle();
  await expect(page.locator('.ah-page main')).toHaveCount(0);
  await expect(
    page.getByText('No heap graph data in this trace'),
  ).toBeVisible();
});

test('returning to a heap-graph trace creates a fresh session', async () => {
  // After we loaded a non-heap-graph trace, switching back to a
  // heap-graph trace must produce a working explorer with all tabs
  // — in particular the empty-state must NOT be sticky.
  await pth.openTraceFile(HEAP_TRACE_A);
  await gotoHeapdumpAndWait();
  for (const [title] of FIXED_TABS) {
    await expect(tabByTitle(title)).toBeVisible();
  }
});
