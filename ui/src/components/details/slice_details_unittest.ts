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

import {buildSliceFlamegraphNodesSql} from './slice_details';

const BASE = {sourceTable: 'src_tbl', idColumn: 'id', valueColumn: 'dur'};

test('slice flamegraph nodes root at the matched slices and add descendants', () => {
  const sql = buildSliceFlamegraphNodesSql(BASE);
  // The matched slices come from the panel's source table.
  expect(sql).toContain('FROM src_tbl src');
  // Roots: matched slices with a nulled parent so they anchor the tree.
  expect(sql).toContain('NULL AS parent_id');
  expect(sql).toContain('JOIN matching USING (id)');
  // Descendants keep their real parent, minus the matched slices themselves.
  expect(sql).toContain('descendant_slice(m.id)');
  expect(sql).toContain('d.id NOT IN (SELECT id FROM matching)');
  // Yields the (id, dur, name, parent_id) node shape.
  expect(sql).toContain('s.id, s.dur, s.name, NULL AS parent_id');
  expect(sql).toContain('d.id, d.dur, d.name, d.parent_id');
});

test('slice flamegraph nodes omit the value-range filter with no brush', () => {
  expect(buildSliceFlamegraphNodesSql(BASE)).not.toContain('BETWEEN');
});

test('slice flamegraph nodes narrow the matched set to the brushed range', () => {
  const sql = buildSliceFlamegraphNodesSql({
    ...BASE,
    brush: {start: 100, end: 500},
  });
  // The range filter applies once, to the matched-slice set only.
  const matches = sql.match(/src\.dur BETWEEN 100 AND 500/g) ?? [];
  expect(matches).toHaveLength(1);
});

test('slice flamegraph nodes honour custom id/value columns', () => {
  const sql = buildSliceFlamegraphNodesSql({
    sourceTable: 't',
    idColumn: 'slice_id',
    valueColumn: 'self_dur',
    brush: {start: 1, end: 2},
  });
  expect(sql).toContain('SELECT src.slice_id AS id');
  expect(sql).toContain('src.self_dur BETWEEN 1 AND 2');
});
