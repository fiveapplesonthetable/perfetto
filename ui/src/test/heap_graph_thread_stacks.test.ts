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

import {test, Page, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

// E2E coverage of HeapGraph.thread_stacks[] + the new
// heap_graph_thread_stack table + Thread Stacks flamegraph metric.
//
// The bulk of correctness is exercised by the trace_processor diff/SQL
// tests; what this file guards against is that the trace itself loads
// in the UI without error after the proto/table/view additions
// (parser regressions, schema mismatches, broken views) and that the
// Thread Stacks metric option is present in the heap-dump flamegraph
// dropdown.

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

const TRACE = 'heap_graph_thread_stacks_test.pftrace';

test.beforeAll(async ({browser}) => {
  // The test trace ships outside the repo (it's a real heap-graph dump
  // produced by the patched ART perfetto_hprof). Skip the suite when
  // it's not present locally so the test file can land without a
  // ~20 MB binary blob in git.
  const fs = await import('fs');
  const path = await import('path');
  const traceCandidate = path.join('..', 'test', 'data', TRACE);
  if (!fs.existsSync(traceCandidate)) {
    test.skip(true, `Trace not found: ${traceCandidate}`);
  }
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  await pth.openTraceFile(TRACE);
});

test('trace with thread_stacks loads without error', async () => {
  // Sidebar must render — implies the trace was processed end-to-end
  // (HeapGraph parser saw the new field, heap_graph_thread_stack table
  // was created, the new SQL view didn't break stdlib bootstrap).
  await expect(page.locator('main > .pf-sidebar')).toBeVisible();
  // No "trace error" notification must surface (independent_features
  // test uses this same indicator).
  await expect(
    page.locator('.pf-notification-icon--error'),
  ).toHaveCount(0);
});

test('Thread Stacks metric is present on the heap-dump flamegraph', async () => {
  // Programmatically open the Java heap graph details panel: simulate
  // selecting the heap-profile track event for the dump. The route
  // takes the form #!/viewer; the page's existing logic auto-selects
  // the first heap profile via dev.perfetto.HeapProfile.onTraceReady.
  await pth.navigate('#!/viewer');
  await pth.waitForPerfettoIdle();

  // The HeapProfile plugin auto-selects the first profile sample on
  // trace ready; that opens the flamegraph details panel.
  const select = page.locator('.pf-flamegraph-profile select').first();
  await select.waitFor({state: 'visible', timeout: 30000});

  // The dropdown must include all five JAVA_HEAP_GRAPH metrics.
  const options = await select.locator('option').allTextContents();
  for (const expected of [
    'Object Size',
    'Object Count',
    'Dominated Object Size',
    'Dominated Object Count',
    'Thread Stacks',
  ]) {
    expect(options).toContain(expected);
  }
});

test('selecting Thread Stacks renders a non-empty flamegraph', async () => {
  const select = page.locator('.pf-flamegraph-profile select').first();
  await select.selectOption('Thread Stacks');
  await pth.waitForPerfettoIdle();

  // The flamegraph is canvas-rendered, so we can't grep frame names
  // via getByText. Instead we assert (a) no SQL/parse error surfaced,
  // (b) the flamegraph widget is mounted with a non-zero canvas, and
  // (c) the metric we just selected is the active one. Together these
  // cover the data-path: if the SQL had returned an error the widget
  // would render an EmptyState instead.
  await expect(select).toHaveValue('Thread Stacks');

  await expect(
    page.locator('.pf-notification-icon--error'),
  ).toHaveCount(0);

  const canvas = page
    .locator('.pf-flamegraph-profile .pf-virtual-canvas canvas')
    .first();
  await canvas.waitFor({state: 'visible', timeout: 15000});
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
  expect(box!.width).toBeGreaterThan(0);

  // No EmptyState shell — would mean the panel decided there's no data.
  await expect(
    page.locator('.pf-flamegraph-profile .pf-empty-state'),
  ).toHaveCount(0);
});
