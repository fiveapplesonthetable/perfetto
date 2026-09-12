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

import type {Trace} from '../../public/trace';
import {configureExtensions} from '../extensions';
import type {DebugSliceTrackArgs} from '../tracks/debug_tracks';
import type {AddSqlTableTabParams} from './sql_table_tab';
import {
  buildSliceFlamegraphNodeActions,
  buildSliceFlamegraphNodesSql,
  SLICE_FLAMEGRAPH_MAX_ROOTS,
} from './slice_details';

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
  // Yields the (id, ts, dur, name, parent_id) node shape (ts is needed so the
  // drill-down can open the region's slices in a new tab).
  expect(sql).toContain('s.id, s.ts, s.dur, s.name, NULL AS parent_id');
  expect(sql).toContain('d.id, d.ts, d.dur, d.name, d.parent_id');
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
  // The cap orders and limits on the same value column.
  expect(sql).toContain('ORDER BY src.self_dur DESC');
});

test('slice flamegraph roots are capped so the descendant walk stays bounded', () => {
  const sql = buildSliceFlamegraphNodesSql({
    ...BASE,
    brush: {start: 1, end: 2},
  });
  expect(sql).toContain('ORDER BY src.dur DESC');
  expect(sql).toContain(`LIMIT ${SLICE_FLAMEGRAPH_MAX_ROOTS}`);
});

test('slice flamegraph node actions offer a drill-down and a debug track', () => {
  const fakeTrace = {} as unknown as Trace;
  const actions = buildSliceFlamegraphNodeActions(fakeTrace)({
    nodesSql: 'SELECT 1',
  });
  expect(actions.map((a) => a.name)).toEqual([
    'Open matching slices',
    'Add debug track',
  ]);
  // Both are drill actions; with no clicked node they are inert (don't throw).
  expect(actions.every((a) => a.category === 'DRILL')).toBe(true);
  expect(() =>
    actions.forEach((a) => a.execute?.({properties: new Map()})),
  ).not.toThrow();
});

test('drill-down opens a scoped slice table and builds debug-track SQL', () => {
  const tableTabs: AddSqlTableTabParams[] = [];
  const debugTracks: DebugSliceTrackArgs[] = [];
  const fakeTrace = {} as unknown as Trace;
  configureExtensions({
    addDebugSliceTrack: async (args: DebugSliceTrackArgs) => {
      debugTracks.push(args);
    },
    addDebugCounterTrack: async () => {},
    addLegacySqlTableTab: (_trace: Trace, config: AddSqlTableTabParams) => {
      tableTabs.push(config);
    },
    addVisualizedArgTracks: async () => {},
  });

  const nodesSql = 'SELECT id, ts, dur, name, parent_id FROM region';
  const actions = buildSliceFlamegraphNodeActions(fakeTrace)({nodesSql});
  // Path from root to the clicked box: same name can sit under several parents,
  // so the drill must target this exact path, not every same-named slice.
  const node = {name: 'msm_bus_scale_req'} as never;
  const path = ['complete_commit', 'prepare_commit', 'msm_bus_scale_req'];

  // "Open matching slices" opens a plain slice table scoped to the clicked box's
  // path via non-recursive parent_id chain joins (one join per path segment).
  actions[0].execute?.({properties: new Map(), node, path});
  expect(tableTabs).toHaveLength(1);
  const filterSql = tableTabs[0].filters![0].op(['id']);
  expect(filterSql).not.toContain('RECURSIVE'); // walks the tree, no recursion
  // Roots come from the region; each path segment is one parent_id edge.
  expect(filterSql).toContain('_roots AS (SELECT id FROM (');
  expect(filterSql).toContain('WHERE parent_id IS NULL');
  expect(filterSql).toContain('JOIN slice s0 ON s0.id = _roots.id');
  expect(filterSql).toContain('JOIN slice s1 ON s1.parent_id = s0.id');
  expect(filterSql).toContain('JOIN slice s2 ON s2.parent_id = s1.id');
  expect(filterSql).toContain('SELECT s2.id AS id');
  expect(filterSql).toContain("'complete_commit'");
  expect(filterSql).toContain("'prepare_commit'");
  expect(filterSql).toContain("'msm_bus_scale_req'");
  // The table keeps the clickable slice id but drops the noise columns.
  const cols = tableTabs[0].table.columns.map((c) => c.column);
  expect(cols).toContain('id');
  expect(cols).not.toContain('category');
  expect(cols).not.toContain('arg_set_id');

  // "Add debug track" builds a slice-track query over the same path-scoped ids,
  // carrying the source id + table_name so debug-track rows link back to the
  // real slice.
  actions[1].execute?.({properties: new Map(), node, path});
  expect(debugTracks).toHaveLength(1);
  expect(debugTracks[0].data.sqlSource).toContain(
    "SELECT s.id, s.ts, s.dur, s.name, 'slice' AS table_name FROM slice s",
  );
  expect(debugTracks[0].data.sqlSource).not.toContain('RECURSIVE');
  expect(debugTracks[0].data.sqlSource).toContain('JOIN slice s2 ON s2.parent_id = s1.id');
});

test('slice flamegraph drill falls back to name scope when no path is given', () => {
  const fakeTrace = {} as unknown as Trace;
  const nodesSql = 'SELECT id, ts, dur, name, parent_id FROM region';
  const actions = buildSliceFlamegraphNodeActions(fakeTrace)({nodesSql});
  const node = {name: 'sde_kms_commit'} as never;
  const tableTabs: AddSqlTableTabParams[] = [];
  configureExtensions({
    addDebugSliceTrack: async () => {},
    addDebugCounterTrack: async () => {},
    addLegacySqlTableTab: (_t: Trace, config: AddSqlTableTabParams) => {
      tableTabs.push(config);
    },
    addVisualizedArgTracks: async () => {},
  });
  actions[0].execute?.({properties: new Map(), node});
  const sql = tableTabs[0].filters![0].op(['id']);
  expect(sql).toContain(`SELECT id FROM (${nodesSql}) WHERE name = 'sde_kms_commit'`);
  expect(sql).not.toContain('WITH RECURSIVE');
});
