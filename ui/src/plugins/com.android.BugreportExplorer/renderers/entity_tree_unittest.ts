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

import type {EntityNode, LineClass} from './entity_tree';
import {buildEntityTree, classifyLine, detectIndentUnit} from './entity_tree';

// The normative test set of the dumpsys grammar: verbatim bugreport lines
// (whitespace significant) and the line class each must map to. If a rule in
// the ordered rule table is added/moved, these must keep passing.
const NORMATIVE_CASES: ReadonlyArray<[string, LineClass]> = [
  // 1: 79-dash rule line.
  [
    '----------------------------------------------------------------' +
      '---------------',
    'SEPARATOR',
  ],
  // 2: priority service header.
  ['DUMP OF SERVICE CRITICAL SurfaceFlinger:', 'SERVICE_HEADER'],
  // 3: dumpsys duration footer.
  [
    '--------- 0.039s was the duration of dumpsys wifip2p, ending at: ' +
      '2026-06-10 09:21:58',
    'SERVICE_FOOTER',
  ],
  // 4: colon property with spaced value.
  ['    mOverlays: size=0', 'PROPERTY_COLON'],
  // 5: tight colon property (no space after ':').
  ['        ringerModeExternal:2', 'PROPERTY_COLON'],
  // 6: single k=v token.
  ['    PresentFences=false', 'PROPERTY_EQUALS'],
  // 7: empty-value property (DeviceConfig).
  ['            5g_icon_display_grace_period_string = ', 'PROPERTY_EQUALS'],
  // 8: hand-rolled k=v run.
  ['    uid=10112 gids=[] type=0 prot=dangerous', 'KV_RUN'],
  // 9: printPair run with trailing space.
  ['   isEnabled=true isSecure=true usesDeviceComposition=true ', 'KV_RUN'],
  // 10: settings-style colon run.
  [
    '_id:115 name:adb_wifi_enabled pkg:android value:0 default:0 ' +
      'defaultSystemSet:true notPreservedInRestore',
    'KV_COLON_RUN',
  ],
  // 11: tab-indented header.
  ['\tTimer:', 'HEADER_COLON'],
  // 12: star record.
  [
    '  * Task{7ec9f08 #9 type=standard A=10068:org.chromium.webview_shell ' +
      'U=0 visible=true mode=fullscreen}',
    'RECORD_STAR',
  ],
  // 13: star record (Hist #N form).
  [
    '    * Hist  #0: ActivityRecord{261536939 u0 ' +
      'org.chromium.webview_shell/.WebViewBrowserActivity t9}',
    'RECORD_STAR',
  ],
  // 14: StateMachine LogRec (1-space indent).
  [
    ' rec[0]: time=06-10 09:02:14.110 processed=DefaultState ' +
      'org=DefaultState dest=<null> what=3(0x3)',
    'RECORD_HASHN',
  ],
  // 15: Intent.toString brace record (balanced, leaf).
  [
    '      Intent { act=android.intent.action.VIEW dat=https://example.com ' +
      'flg=0x10000000 xflg=0x4 ' +
      'cmp=org.chromium.webview_shell/.WebViewBrowserActivity }',
    'RECORD_BRACE',
  ],
  // 16: proto-text block open.
  ['predicted_hotseat_container {', 'BLOCK_OPEN'],
  // 17: closing punctuation line.
  ['      }', 'BRACE_DELIM'],
  // 18: media-resource event (no millis).
  [
    '    06-10 09:02:12 removeResource(pid 4069, uid 10099 clientId ' +
      '134592065584880)',
    'TIMESTAMPED_EVENT',
  ],
  // 19: numeric key with braced value.
  [
    '  143: {extractor, (06-10 09:02:14.110), (media, 0, 1013), (codec)}',
    'PROPERTY_COLON',
  ],
  // 20: identityHashCode record.
  ['        e7687d9 com.android.certinstaller/.CertInstallerMain', 'RECORD_ID'],
  // 21: bare path list element.
  [
    '        /data/resource-cache/com.android.systemui-neutral-RwKA.frro',
    'VALUE_ITEM',
  ],
  // 22: bare label (header iff next line deeper).
  ['Features', 'BARE_LABEL'],
  // 23: idmap-style arrow mapping.
  [
    '    0x0106038b -> color 0xffffffff (color/system_accent1_0_dark)',
    'ARROW_MAP',
  ],
  // 24: bracketed raw data row.
  ['        [540422489 240 180 OUTPUT ]', 'ARRAY_VALUE'],
  // 25: aligned-column table row (meminfo).
  [
    '     .so mmap     8883       60     5752     1688    70192       ' +
      '60        0    77692',
    'TABLE_ROW_ALIGNED',
  ],
  // 26: pipe table row (SurfaceFlinger).
  [
    '            Handle |         Size |     W (Stride) x H | Layers |   ' +
      'Format | Usage | State',
    'TABLE_ROW_PIPE',
  ],
  // 27: compat-framework paren record.
  [
    'ChangeId(189969744; name=DOWNSCALE_65; disabled; overridable)',
    'RECORD_PAREN',
  ],
  // 28: banner separator.
  ['** Cache info for pid 4886 [org.chromium.webview_shell] **', 'SEPARATOR'],
  // 29: box-drawing hierarchy row.
  [' │  ├─ WindowedMagnification:0:31#3 pid=1211 uid=1000', 'TREE_DRAW'],
  // 30: formatDuration value.
  ['                        TOTAL: +19m44s535ms', 'PROPERTY_COLON'],
  // 31: irreducible prose.
  [
    '    com.android.internal.systemui.navbar.gestural_wide_back is ' +
      'allowlisted but not present.',
    'PROSE',
  ],
];

describe('classifyLine', () => {
  NORMATIVE_CASES.forEach(([line, expected], i) => {
    it(`normative #${i + 1} -> ${expected}`, () => {
      expect(classifyLine(line).cls).toEqual(expected);
    });
  });

  it('classifies blank-ish lines', () => {
    expect(classifyLine('').cls).toEqual('BLANKISH');
    expect(classifyLine('   \t ').cls).toEqual('BLANKISH');
  });
});

describe('detectIndentUnit', () => {
  it('detects 4-space sections', () => {
    const lines = ['Scheduler:', '    mFoo: 1', '        mBar: 2'];
    expect(detectIndentUnit(lines.map(classifyLine))).toEqual(4);
  });

  it('detects tab sections (tab = 8 columns)', () => {
    const lines = ['Timer:', '\ttotal: 12', '\t\tpending: 3'];
    expect(detectIndentUnit(lines.map(classifyLine))).toEqual(8);
  });

  it('defaults to the IndentingPrintWriter 2-space unit', () => {
    expect(detectIndentUnit([])).toEqual(2);
    const lines = ['a: 1', '  b: 2', '  c: 3'];
    expect(detectIndentUnit(lines.map(classifyLine))).toEqual(2);
  });
});

function countsTotal(tree: ReturnType<typeof buildEntityTree>): number {
  const c = tree.counts;
  return c.entity + c.property + c.text + c.table + c.event;
}

function childByName(node: EntityNode, name: string): EntityNode | undefined {
  return node.children.find((c) => c.name === name);
}

describe('buildEntityTree', () => {
  it('parses a mini ServiceRecord block with an event log', () => {
    const lines = [
      '* ServiceRecord{c0ffee0 u0 com.foo/.Bar}',
      '    intent={act=android.intent.action.MAIN}',
      '    packageName=com.foo',
      '    Events log: service lifecycle',
      '      06-10 09:02:12 - created',
      '      06-10 09:02:13 - started',
    ];
    const tree = buildEntityTree(lines);

    expect(tree.roots.length).toEqual(1);
    const rec = tree.roots[0];
    expect(rec.name).toEqual('ServiceRecord');
    expect(rec.suffix).toEqual('{c0ffee0 u0 com.foo/.Bar}');
    expect(rec.props).toEqual([
      {key: 'intent', value: '{act=android.intent.action.MAIN}'},
      {key: 'packageName', value: 'com.foo'},
    ]);

    // "Events log:" is adopted as a header; its events group into a single
    // "Events (2)" child entity with a two-column ts|message payload.
    const log = childByName(rec, 'Events log');
    expect(log).toBeDefined();
    const events = childByName(log!, 'Events (2)');
    expect(events?.table).toEqual({
      kind: 'events',
      columns: ['Timestamp', 'Message'],
      rows: [
        ['06-10 09:02:12', 'created'],
        ['06-10 09:02:13', 'started'],
      ],
    });

    expect(tree.counts).toEqual({
      entity: 2, // ServiceRecord + "Events log" header.
      property: 2,
      text: 0,
      table: 0,
      event: 2,
    });
    expect(countsTotal(tree)).toEqual(6);
  });

  it('splits a KV_RUN into one property per token', () => {
    const tree = buildEntityTree([
      'Permissions:',
      '  uid=10112 gids=[] type=0 prot=dangerous',
    ]);
    const perms = tree.roots[0];
    expect(perms.name).toEqual('Permissions');
    expect(perms.props).toEqual([
      {key: 'uid', value: '10112'},
      {key: 'gids', value: '[]'},
      {key: 'type', value: '0'},
      {key: 'prot', value: 'dangerous'},
    ]);
    // One input line, however many properties it splits into.
    expect(tree.counts.property).toEqual(1);
    expect(countsTotal(tree)).toEqual(2);
  });

  it('groups consecutive pipe rows into a table payload', () => {
    const tree = buildEntityTree([
      'Buffers:',
      '  Handle | Size | Format',
      '  0xb400 | 1024 | RGBA_8888',
      '  0xb500 | 2048 | RGBA_8888',
    ]);
    const buffers = tree.roots[0];
    const table = childByName(buffers, 'Table (2 rows)');
    expect(table?.table).toEqual({
      kind: 'table',
      columns: ['Handle', 'Size', 'Format'],
      rows: [
        ['0xb400', '1024', 'RGBA_8888'],
        ['0xb500', '2048', 'RGBA_8888'],
      ],
    });
    expect(tree.counts.table).toEqual(3); // Header row + 2 data rows.
    expect(countsTotal(tree)).toEqual(4);
  });

  it('balances DualDumpOutputStream brace blocks', () => {
    const tree = buildEntityTree([
      'settings={',
      '  fancy_feature=true',
      '}',
      'trailing=1',
    ]);
    const settings = tree.roots.find((r) => r.name === 'settings');
    expect(settings?.props).toEqual([{key: 'fancy_feature', value: 'true'}]);
    // The "}" pops the block: "trailing=1" lands at the top level (grouped
    // under the synthetic Overview entity), not inside the block.
    const overview = tree.roots.find((r) => r.name === 'Overview');
    expect(overview?.props).toEqual([{key: 'trailing', value: '1'}]);
    expect(countsTotal(tree)).toEqual(4);
  });

  it('conserves every non-blank line across mixed content', () => {
    const lines = [
      'ACTIVITY MANAGER SERVICES (dumpsys activity services)',
      '  User 0 active services:',
      '  * ServiceRecord{1a2b3c4 u0 com.foo/.Bar}',
      '    app=ProcessRecord{5ba57a8 1211:system/1000}',
      '',
      '  ----------------------------------------',
      '  Features',
      '    com.android.uwb.resources',
      '    0x0106038b -> color 0xffffffff (color/system_accent1_0_dark)',
      '',
      '  free prose trailing line that matches nothing in particular x y z',
    ];
    const tree = buildEntityTree(lines);
    const nonBlank = lines.filter((l) => l.trim() !== '').length;
    expect(countsTotal(tree)).toEqual(nonBlank);
    // The ALL-CAPS "(dumpsys ...)" header scopes the whole section.
    expect(tree.roots.length).toEqual(1);
    expect(tree.roots[0].name).toEqual(
      'ACTIVITY MANAGER SERVICES (dumpsys activity services)',
    );
  });
});
