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

import m from 'mithril';
import type {Trace} from '../../../public/trace';
import type {time} from '../../../base/time';
import type {Engine} from '../../../trace_processor/engine';
import type {QueryFlamegraphMetric} from '../../../components/query_flamegraph';
import {FlamegraphPanel} from '../../../components/flamegraph_panel';
import {
  Flamegraph,
  type FlamegraphState,
  type FlamegraphOptionalAction,
} from '../../../widgets/flamegraph';
import {FlamegraphDiffLegend} from '../../../widgets/flamegraph_diff_legend';
import {QuerySlot} from '../../../base/query_slot';
import {
  isHeapGraphIncomplete,
  incompleteFlamegraphModal,
} from '../../dev.perfetto.HeapProfile/incomplete_flamegraph';
import {Callout} from '../../../widgets/callout';
import {Intent} from '../../../widgets/common';
import {Spinner} from '../../../widgets/spinner';
import {prepareCrossTraceDiff} from '../diff/cross_trace_diff';

// Referenced by session.openFlamegraphPivotedAt.
export const METRIC_OBJECT_SIZE = 'Object Size';
export const METRIC_DOMINATED_OBJECT_SIZE = 'Dominated Object Size';

// Same-trace baseline: dump (upid, ts) within the same engine. The diff
// SQL JOINs the current and baseline class trees on `path_hash_stable`
// (computed by hashing parent path + type_id + heap_type — stable across
// dumps in a single trace because class ids are trace-global).
export interface FlamegraphBaselineRef {
  readonly upid: number;
  readonly ts: time;
}

interface FlamegraphViewAttrs {
  readonly trace: Trace;
  readonly upid: number;
  readonly ts: time;
  readonly state: FlamegraphState | undefined;
  readonly onStateChange: (state: FlamegraphState) => void;
  // Open the flamegraph-objects tab for `pathHashes` (CSV).
  readonly onShowObjects: (pathHashes: string, isDominator: boolean) => void;
  // When set, build diff metrics that color nodes by delta direction and
  // size them by |delta|. For same-trace baselines (`baselineEngine`
  // unset), pairing happens in SQL via _graph_scan path hashes. For
  // cross-trace baselines (`baselineEngine` set to a different engine),
  // pairing happens in JS — see diff/cross_trace_diff.ts.
  readonly baseline?: FlamegraphBaselineRef;
  // The engine to fetch the baseline's class tree from. Leave unset for
  // same-trace baselines (the diff SQL queries `attrs.trace.engine`). Set
  // to a different engine for cross-trace pairing.
  readonly baselineEngine?: Engine;
}

// path_hash_stable is exposed unaggregatable (and CAST to TEXT in SQL,
// since the stdlib emits it as INT64 and the flamegraph reads
// unaggregatable columns as STR_NULL) so it lands in `matchingColumns`
// — that's what lets a PIVOT filter target a specific node by its hash.
// Hidden from the tooltip via `isVisible: false`.
const UNAGG_PROPS = [
  {name: 'root_type', displayName: 'Root Type'},
  {name: 'heap_type', displayName: 'Heap Type'},
  {
    name: 'path_hash_stable',
    displayName: 'Path Hash',
    isVisible: () => false,
  },
];

const SELF_COUNT_AGG_PROP = {
  name: 'self_count',
  displayName: 'Self Count',
  mergeAggregation: 'SUM' as const,
};

// Build a JAVA_HEAP_GRAPH metric for the BFS or dominator class tree,
// projecting `valueColumn` as `value` and the other column for tooltips.
function buildMetric(
  upid: number,
  ts: time,
  name: string,
  unit: string,
  valueColumn: 'self_size' | 'self_count',
  isDominator: boolean,
  showObjectsAction: FlamegraphOptionalAction,
): QueryFlamegraphMetric {
  const tree = isDominator
    ? '_heap_graph_dominator_class_tree'
    : '_heap_graph_class_tree';
  const dependencyModule = isDominator
    ? 'android.memory.heap_graph.dominator_class_tree'
    : 'android.memory.heap_graph.class_tree';
  const otherCol = valueColumn === 'self_size' ? 'self_count' : 'self_size';
  return {
    name,
    unit,
    dependencySql: `include perfetto module ${dependencyModule};`,
    statement: `
      select
        id,
        parent_id as parentId,
        coalesce(name, '<' || coalesce(replace(heap_type, 'HEAP_TYPE_', ''), root_type, 'unnamed') || '>') as name,
        root_type,
        heap_type,
        ${valueColumn} as value,
        ${otherCol},
        CAST(path_hash_stable AS TEXT) AS path_hash_stable
      from ${tree}
      where graph_sample_ts = ${ts} and upid = ${upid}
    `,
    unaggregatableProperties: UNAGG_PROPS,
    aggregatableProperties:
      valueColumn === 'self_size' ? [SELF_COUNT_AGG_PROP] : [],
    optionalNodeActions: [showObjectsAction],
  };
}

interface MetricSpec {
  readonly name: string;
  readonly unit: string;
  readonly valueColumn: 'self_size' | 'self_count';
  readonly isDominator: boolean;
}

const METRIC_SPECS: ReadonlyArray<MetricSpec> = [
  {
    name: METRIC_OBJECT_SIZE,
    unit: 'B',
    valueColumn: 'self_size',
    isDominator: false,
  },
  {
    name: 'Object Count',
    unit: '',
    valueColumn: 'self_count',
    isDominator: false,
  },
  {
    name: METRIC_DOMINATED_OBJECT_SIZE,
    unit: 'B',
    valueColumn: 'self_size',
    isDominator: true,
  },
  {
    name: 'Dominated Object Count',
    unit: '',
    valueColumn: 'self_count',
    isDominator: true,
  },
];

function buildHeapGraphMetrics(
  upid: number,
  ts: time,
  onShowObjects: (pathHashes: string, isDominator: boolean) => void,
): ReadonlyArray<QueryFlamegraphMetric> {
  const showObjectsAction = (
    isDominator: boolean,
  ): FlamegraphOptionalAction => ({
    name: 'Show objects from this class',
    icon: 'data_object',
    category: 'DRILL',
    description: 'List the individual objects of this class.',
    execute: async ({properties}) => {
      const pathHashes = properties.get('path_hash_stable');
      if (pathHashes === undefined) return;
      onShowObjects(pathHashes, isDominator);
    },
  });
  return METRIC_SPECS.map((s) =>
    buildMetric(
      upid,
      ts,
      s.name,
      s.unit,
      s.valueColumn,
      s.isDominator,
      showObjectsAction(s.isDominator),
    ),
  );
}

// ---------- Diff metrics (same-trace) -------------------------------------

// How the diff colour score is normalised:
//   'absolute' — Δ / max(|Δ|) across the tree: big movers stand out, units
//                are the metric's own (bytes / count).
//   'relative' — Δ / baseline per node (fractional change), clamped to
//                [-1, 1]; a node absent from the baseline reads as +1.
// The user picks one via the selected metric. Width is always |Δ|; the
// Current / Baseline modes show the plain heap shapes.
type ColorBasis = 'absolute' | 'relative';

// Build a JAVA_HEAP_GRAPH diff metric with |Δ|-sized boxes and Δ-coloured
// fills.
//
// Pairing uses a name-based path hash recomputed via _graph_scan: the
// stdlib's `path_hash_stable` is hashed from class **ids**, which are
// per-process and not even always shared across dumps of one upid.
// Hashing class names + heap_type instead makes the join key stable
// across processes and across dumps within one trace.
function buildDiffMetric(
  cur: FlamegraphBaselineRef,
  base: FlamegraphBaselineRef,
  name: string,
  unit: string,
  valueColumn: 'self_size' | 'self_count',
  isDominator: boolean,
  showObjectsAction: FlamegraphOptionalAction,
  colorBasis: ColorBasis = 'absolute',
): QueryFlamegraphMetric {
  const tree = isDominator
    ? '_heap_graph_dominator_class_tree'
    : '_heap_graph_class_tree';
  const dependencyModule = isDominator
    ? 'android.memory.heap_graph.dominator_class_tree'
    : 'android.memory.heap_graph.class_tree';
  const dim = valueColumn === 'self_size' ? 'size' : 'count';
  // _graph_scan propagates a hash from each node to its children, where
  // each step folds the child's name + heap_type into the parent hash.
  // The resulting `h` is a path-of-names hash — stable across dumps and
  // processes wherever the same class-name path exists.
  const pathHashScan = (upid: number, ts: number | bigint): string => `
    _graph_scan!(
      (
        SELECT parent_id AS source_node_id, id AS dest_node_id
        FROM ${tree}
        WHERE upid = ${upid} AND graph_sample_ts = ${ts}
          AND parent_id IS NOT NULL
      ),
      (
        SELECT id,
               HASH(IFNULL(name, ''), IFNULL(heap_type, ''), IFNULL(root_type, '')) AS h
        FROM ${tree}
        WHERE upid = ${upid} AND graph_sample_ts = ${ts}
          AND parent_id IS NULL
      ),
      (h),
      (
        SELECT t.id,
               HASH(t.h, IFNULL(c.name, ''), IFNULL(c.heap_type, '')) AS h
        FROM $table t
        JOIN ${tree} c ON c.id = t.id
      )
    )
  `;
  // MATERIALIZED forces SQLite to actually realise these CTEs (and build
  // automatic indexes on join columns). Without it, the LEFT JOIN below on
  // path_h degenerates to a nested-loop scan — O(N*M), tens of seconds on a
  // single real system_server heap dump. ~20× speedup measured locally.
  const statement = `
    WITH
    cur_path_hash AS MATERIALIZED (SELECT * FROM ${pathHashScan(cur.upid, cur.ts)}),
    base_path_hash AS MATERIALIZED (SELECT * FROM ${pathHashScan(base.upid, base.ts)}),
    cur_nodes AS MATERIALIZED (
      SELECT t.id, t.parent_id,
             coalesce(t.name, '<' || coalesce(replace(t.heap_type, 'HEAP_TYPE_', ''), t.root_type, 'unnamed') || '>') AS name,
             t.root_type, t.heap_type,
             ph.h AS path_h,
             t.self_size AS c_self_size, t.self_count AS c_self_count
      FROM ${tree} t JOIN cur_path_hash ph USING (id)
      WHERE t.upid = ${cur.upid} AND t.graph_sample_ts = ${cur.ts}
    ),
    base_full AS MATERIALIZED (
      SELECT t.id, t.parent_id,
             coalesce(t.name, '<' || coalesce(replace(t.heap_type, 'HEAP_TYPE_', ''), t.root_type, 'unnamed') || '>') AS name,
             t.root_type, t.heap_type,
             ph.h AS path_h, pph.h AS parent_h,
             t.self_size, t.self_count
      FROM ${tree} t
      JOIN base_path_hash ph USING (id)
      LEFT JOIN base_path_hash pph ON pph.id = t.parent_id
      WHERE t.upid = ${base.upid} AND t.graph_sample_ts = ${base.ts}
    ),
    base_nodes AS MATERIALIZED (
      -- GROUP BY path_h so the LEFT JOIN below can never cross-product
      -- against the base side, even if two base tree nodes happen to share
      -- a path identity. Aggregated values are the natural fold (sum).
      SELECT path_h,
             SUM(self_size) AS b_self_size,
             SUM(self_count) AS b_self_count
      FROM base_full
      GROUP BY path_h
    ),
    cur_by_path AS MATERIALIZED (
      SELECT path_h, MIN(id) AS id FROM cur_nodes GROUP BY path_h
    ),
    -- Baseline-only paths render as removed nodes (current value 0). They
    -- attach under the paired parent when the parent's path exists in the
    -- current tree, else under their (also synthesized) baseline parent.
    -- Baseline tree ids are safe to reuse as node ids: the class-tree id
    -- space is shared across the dumps of one trace.
    base_only AS MATERIALIZED (
      SELECT MIN(bf.id) AS id,
             coalesce(MIN(cbp.id), MIN(bf.parent_id)) AS parent_id,
             MIN(bf.name) AS name,
             MIN(bf.root_type) AS root_type,
             MIN(bf.heap_type) AS heap_type,
             bf.path_h,
             SUM(bf.self_size) AS b_self_size,
             SUM(bf.self_count) AS b_self_count
      FROM base_full bf
      LEFT JOIN cur_by_path cbp ON cbp.path_h = bf.parent_h
      WHERE bf.path_h NOT IN (SELECT path_h FROM cur_by_path)
      GROUP BY bf.path_h
    ),
    joined AS (
      SELECT
        c.id,
        c.parent_id,
        c.name,
        c.root_type,
        c.heap_type,
        c.path_h,
        c.c_self_size, c.c_self_count,
        ifnull(b.b_self_size, 0) AS b_self_size,
        ifnull(b.b_self_count, 0) AS b_self_count,
        c.c_self_size - ifnull(b.b_self_size, 0) AS delta_size,
        c.c_self_count - ifnull(b.b_self_count, 0) AS delta_count
      FROM cur_nodes c LEFT JOIN base_nodes b USING (path_h)
      UNION ALL
      SELECT
        id, parent_id, name, root_type, heap_type, path_h,
        0, 0,
        b_self_size, b_self_count,
        -b_self_size, -b_self_count
      FROM base_only
    ),
    stats AS (SELECT max(abs(delta_${dim})) AS m FROM joined)
    SELECT
      j.id,
      j.parent_id AS parentId,
      j.name,
      j.root_type,
      j.heap_type,
      CAST(j.path_h AS TEXT) AS path_hash_stable,
      abs(j.delta_${dim}) AS value,
      j.c_self_size, j.b_self_size, j.delta_size,
      j.c_self_count, j.b_self_count, j.delta_count,
      -- color_hint = 'diff:<score>' with score in [-1, 1]; see
      -- getColorSchemeFromHint in flamegraph.ts (pprof-style colouring).
      ${
        colorBasis === 'relative'
          ? `CASE
        WHEN j.delta_${dim} = 0 THEN 'diff:0'
        -- No baseline mass (new node) ⇒ unbounded growth ⇒ full red.
        WHEN j.b_self_${dim} = 0 THEN 'diff:1'
        ELSE printf('diff:%.4f',
          max(-1.0, min(1.0, j.delta_${dim} * 1.0 / j.b_self_${dim})))
      END`
          : `CASE
        WHEN s.m IS NULL OR s.m = 0 THEN 'diff:0'
        ELSE printf('diff:%.4f', j.delta_${dim} * 1.0 / s.m)
      END`
      } AS color_hint
    FROM joined j CROSS JOIN stats s
  `;
  return {
    name,
    unit,
    dependencySql:
      `include perfetto module ${dependencyModule};\n` +
      `include perfetto module graphs.scan;`,
    statement,
    unaggregatableProperties: UNAGG_PROPS,
    aggregatableProperties: [
      {
        name: 'delta_size',
        displayName: 'Δ Size',
        unit: 'B',
        mergeAggregation: 'SUM' as const,
      },
      {
        name: 'delta_count',
        displayName: 'Δ Count',
        unit: 'count',
        mergeAggregation: 'SUM' as const,
      },
    ],
    optionalNodeActions: [showObjectsAction],
    colorHint: true,
  };
}

function buildHeapGraphDiffMetrics(
  cur: FlamegraphBaselineRef,
  base: FlamegraphBaselineRef,
  onShowObjects: (pathHashes: string, isDominator: boolean) => void,
): ReadonlyArray<QueryFlamegraphMetric> {
  const showObjectsAction = (
    isDominator: boolean,
  ): FlamegraphOptionalAction => ({
    name: 'Show objects from this class',
    execute: async ({properties}) => {
      const pathHashes = properties.get('path_hash_stable');
      if (pathHashes === undefined) return;
      onShowObjects(pathHashes, isDominator);
    },
  });
  // Two metrics per spec — pprof-style:
  //   * absolute (width = current dump's value, colour = Δ direction)
  //     — same flamegraph shape the user saw before engaging diff, with
  //     change information layered in via hue / saturation.
  //   * Δ (width = |Δ|, colour = Δ direction) — emphasises movement.
  //
  // Δ comes first so entering diff mode lands on Δ Object Size (absolute),
  // matching
  // the prior behaviour. Both variants share the same CTE / pairing, so
  // SQLite materializes the JOIN once per (dim, isDominator); only the
  // `value` column expression differs.
  //
  // Only nodes present in current are paired here — nodes that exist
  // in baseline but not current (REMOVED) are dropped because they have
  // no place in the current tree's id/parent_id structure. They show up
  // when the user flips primary and baseline.
  // Three metrics per spec, all sharing the same pairing CTE:
  //   * `Δ {name} (absolute)`   — colour = Δ / max|Δ| across the tree.
  //   * `Δ {name} (relative %)` — colour = Δ / baseline per node.
  // Width is |Δ| in both; the Current / Baseline modes show the plain heap
  // shapes, keeping filters, pivots and the selected measure.
  const metrics: QueryFlamegraphMetric[] = [];
  for (const s of METRIC_SPECS) {
    const action = showObjectsAction(s.isDominator);
    metrics.push(
      buildDiffMetric(
        cur,
        base,
        `Δ ${s.name} (absolute)`,
        s.unit,
        s.valueColumn,
        s.isDominator,
        action,
        'absolute',
      ),
    );
    metrics.push(
      buildDiffMetric(
        cur,
        base,
        `Δ ${s.name} (relative %)`,
        s.unit,
        s.valueColumn,
        s.isDominator,
        action,
        'relative',
      ),
    );
  }
  return metrics;
}

// ---------- Cross-trace diff metrics --------------------------------------

// Build a JAVA_HEAP_GRAPH diff metric that reads from a pre-paired temp
// table (see diff/cross_trace_diff.ts) instead of pairing in SQL. The
// downstream value / colour-hint logic is identical to the same-trace
// path — only the source of `joined` differs.
function buildCrossTraceDiffMetric(
  pairedTable: string,
  name: string,
  unit: string,
  valueColumn: 'self_size' | 'self_count',
  showObjectsAction: FlamegraphOptionalAction,
  colorBasis: ColorBasis = 'absolute',
): QueryFlamegraphMetric {
  const dim = valueColumn === 'self_size' ? 'size' : 'count';
  const valExpr = `abs(j.delta_${dim})`;
  const colorExpr =
    colorBasis === 'relative'
      ? `CASE
          WHEN j.delta_${dim} = 0 THEN 'diff:0'
          WHEN j.b_self_${dim} = 0 THEN 'diff:1'
          ELSE printf('diff:%.4f',
            max(-1.0, min(1.0, j.delta_${dim} * 1.0 / j.b_self_${dim})))
        END`
      : `CASE
          WHEN s.m IS NULL OR s.m = 0 THEN 'diff:0'
          ELSE printf('diff:%.4f', j.delta_${dim} * 1.0 / s.m)
        END`;
  const statement = `
    WITH
    joined AS (SELECT * FROM ${pairedTable}),
    stats AS (SELECT max(abs(delta_${dim})) AS m FROM joined)
    SELECT
      j.id,
      j.parent_id AS parentId,
      j.name,
      j.root_type,
      j.heap_type,
      j.path_hash_stable,
      ${valExpr} AS value,
      j.c_self_size, j.b_self_size, j.delta_size,
      j.c_self_count, j.b_self_count, j.delta_count,
      ${colorExpr} AS color_hint
    FROM joined j CROSS JOIN stats s
  `;
  return {
    name,
    unit,
    // The temp table is created up-front by prepareCrossTraceDiff. We
    // still need a non-empty dependencySql for the QueryFlamegraph
    // machinery, so do a harmless no-op.
    dependencySql: 'SELECT 1;',
    statement,
    unaggregatableProperties: UNAGG_PROPS,
    aggregatableProperties: [
      {
        name: 'delta_size',
        displayName: 'Δ Size',
        unit: 'B',
        mergeAggregation: 'SUM' as const,
      },
      {
        name: 'delta_count',
        displayName: 'Δ Count',
        unit: 'count',
        mergeAggregation: 'SUM' as const,
      },
    ],
    optionalNodeActions: [showObjectsAction],
    colorHint: true,
  };
}

// Cross-trace counterpart of buildHeapGraphDiffMetrics. Same set of 12
// metrics (4 specs × {Δ, Δ-relative, current-width}), each pointed at the
// appropriate pre-paired temp table.
function buildCrossTraceHeapGraphDiffMetrics(
  classTreeTable: string,
  dominatorTreeTable: string,
  onShowObjects: (pathHashes: string, isDominator: boolean) => void,
): ReadonlyArray<QueryFlamegraphMetric> {
  const showObjectsAction = (
    isDominator: boolean,
  ): FlamegraphOptionalAction => ({
    name: 'Show objects from this class',
    execute: async ({properties}) => {
      const pathHashes = properties.get('path_hash_stable');
      if (pathHashes === undefined) return;
      onShowObjects(pathHashes, isDominator);
    },
  });
  const metrics: QueryFlamegraphMetric[] = [];
  for (const s of METRIC_SPECS) {
    const table = s.isDominator ? dominatorTreeTable : classTreeTable;
    const action = showObjectsAction(s.isDominator);
    metrics.push(
      buildCrossTraceDiffMetric(
        table,
        `Δ ${s.name} (absolute)`,
        s.unit,
        s.valueColumn,
        action,
        'absolute',
      ),
    );
    metrics.push(
      buildCrossTraceDiffMetric(
        table,
        `Δ ${s.name} (relative %)`,
        s.unit,
        s.valueColumn,
        action,
        'relative',
      ),
    );
  }
  return metrics;
}

// Keeps the metric selection meaningful across Diff / Current / Baseline
// toggles: 'Δ Object Size (absolute)' maps to 'Object Size' and back, so a
// mode flip compares the same measure instead of resetting to the first one.
function mapMetricAcrossModes(
  id: string,
  metrics: ReadonlyArray<QueryFlamegraphMetric>,
): string | undefined {
  const has = (x: string) => metrics.some((m) => (m.id ?? m.name) === x);
  if (has(id)) return id;
  const plain = id
    .replace(/^Δ /, '')
    .replace(/ \((absolute|relative %)\)$/, '');
  for (const candidate of [`Δ ${plain} (absolute)`, plain]) {
    if (has(candidate)) return candidate;
  }
  return undefined;
}

// Shown only in diff mode, overlaid on the flamegraph's corner.
function renderDiffLegend(relative: boolean): m.Child {
  return m(
    '.pf-hde-diff-legend',
    m(FlamegraphDiffLegend, {
      basisLabel: relative ? 'relative (%)' : 'absolute',
    }),
  );
}

// Per-component counter for cross-trace temp table names. Engine-global
// uniqueness, not cryptographic; just needs to not collide across
// re-prepares within one engine.
let xTraceTableSeq = 0;

export const FlamegraphView: m.ClosureComponent<FlamegraphViewAttrs> = () => {
  let cachedMetrics: ReadonlyArray<QueryFlamegraphMetric> | undefined;
  let cachedKey: string | undefined;

  // Mirrors dev.perfetto.HeapProfile: if the heap graph is incomplete we gate
  // the flamegraph behind a dismissible warning modal. Keyed by dump so it
  // re-arms when the dump changes; the check runs (and the modal is shown) only
  // when this view is rendered, i.e. when the flamegraph tab is active.
  const incompleteSlot = new QuerySlot<{
    isIncomplete: boolean;
    dismissed: boolean;
  }>();

  // Cross-trace prep state. `key` matches the metric key when prep has
  // completed for the current (cur, base, engines) tuple, so a stale
  // baseline change leaves the old prep visibly out-of-date and we'll
  // re-prep.
  let prep:
    | {
        readonly key: string;
        status: 'pending' | 'ready' | 'error';
        classTable?: string;
        dominatorTable?: string;
        error?: Error;
      }
    | undefined;

  return {
    view({attrs}) {
      const isCrossTrace =
        attrs.baseline !== undefined && attrs.baselineEngine !== undefined;
      const baselineKey = attrs.baseline
        ? `${attrs.baseline.upid}:${attrs.baseline.ts}`
        : 'none';
      // The cross-trace key includes the baseline engine in `isCrossTrace`
      // so swapping baseline traces invalidates the prep.
      const key = `${attrs.upid}:${attrs.ts}|${baselineKey}|${
        isCrossTrace ? 'x' : 's'
      }`;

      // Kick off cross-trace prep if needed.
      if (isCrossTrace && (prep === undefined || prep.key !== key)) {
        const seq = xTraceTableSeq++;
        const classTable = `_x_diff_class_${seq}`;
        const dominatorTable = `_x_diff_dom_${seq}`;
        const myPrep: NonNullable<typeof prep> = {key, status: 'pending'};
        prep = myPrep;
        const curRef = {upid: attrs.upid, ts: BigInt(attrs.ts)};
        const baseRef = {
          upid: attrs.baseline!.upid,
          ts: BigInt(attrs.baseline!.ts),
        };
        Promise.all([
          prepareCrossTraceDiff(
            classTable,
            attrs.trace.engine,
            curRef,
            attrs.baselineEngine!,
            baseRef,
            '_heap_graph_class_tree',
          ),
          prepareCrossTraceDiff(
            dominatorTable,
            attrs.trace.engine,
            curRef,
            attrs.baselineEngine!,
            baseRef,
            '_heap_graph_dominator_class_tree',
          ),
        ])
          .then(() => {
            // Ignore the result if a newer prep has taken over.
            if (prep !== myPrep) return;
            myPrep.status = 'ready';
            myPrep.classTable = classTable;
            myPrep.dominatorTable = dominatorTable;
            // Force the metric cache to rebuild — `key` already matches.
            cachedMetrics = undefined;
            cachedKey = undefined;
            m.redraw();
          })
          .catch((err: Error) => {
            if (prep !== myPrep) return;
            myPrep.status = 'error';
            myPrep.error = err;
            m.redraw();
          });
      }
      if (!isCrossTrace) prep = undefined;

      if (isCrossTrace && prep !== undefined && prep.status === 'pending') {
        return m(
          'div',
          {class: 'pf-hde-view-content pf-hde-flamegraph-view'},
          m(
            Callout,
            {icon: 'memory', intent: Intent.None},
            m(Spinner, {easing: true}),
            ' Preparing cross-trace diff: pairing class trees…',
          ),
        );
      }
      if (isCrossTrace && prep !== undefined && prep.status === 'error') {
        return m(
          'div',
          {class: 'pf-hde-view-content pf-hde-flamegraph-view'},
          m(
            Callout,
            {icon: 'error', intent: Intent.Danger},
            `Cross-trace diff failed: ${prep.error?.message ?? 'unknown error'}`,
          ),
        );
      }

      const metricsChanged = cachedMetrics === undefined || key !== cachedKey;
      if (metricsChanged || cachedMetrics === undefined) {
        if (isCrossTrace && prep?.status === 'ready') {
          cachedMetrics = buildCrossTraceHeapGraphDiffMetrics(
            prep.classTable!,
            prep.dominatorTable!,
            attrs.onShowObjects,
          );
        } else if (attrs.baseline) {
          cachedMetrics = buildHeapGraphDiffMetrics(
            {upid: attrs.upid, ts: attrs.ts},
            attrs.baseline,
            attrs.onShowObjects,
          );
        } else {
          cachedMetrics = buildHeapGraphMetrics(
            attrs.upid,
            attrs.ts,
            attrs.onShowObjects,
          );
        }
        cachedKey = key;
      }
      const metrics: ReadonlyArray<QueryFlamegraphMetric> = cachedMetrics;

      const incomplete = incompleteSlot.use({
        key: {upid: attrs.upid, ts: attrs.ts},
        queryFn: async () => ({
          isIncomplete: await isHeapGraphIncomplete(attrs.trace),
          dismissed: false,
        }),
      }).data;

      // Either first render OR a dump/baseline change just swapped the
      // metric list. Diff mode renames every metric (`Δ Object Size (absolute)`
      // etc.), so a stale state.selectedMetricId from before the flip
      // points at a metric that no longer exists. Flamegraph.updateState
      // rebuilds the state, falling back to the first metric when the
      // selection disappeared. Without this the panel either renders
      // nothing or stays on the old metric set.
      let state = attrs.state;
      if (state === undefined || metricsChanged) {
        if (state !== undefined) {
          const mapped = mapMetricAcrossModes(state.selectedMetricId, metrics);
          if (mapped !== undefined && mapped !== state.selectedMetricId) {
            state = {...state, selectedMetricId: mapped};
          }
        }
        state = Flamegraph.updateState(state, metrics);
        attrs.onStateChange(state);
      }

      const legend = attrs.baseline
        ? renderDiffLegend(state.selectedMetricId.includes('(relative %)'))
        : null;

      return m(
        'div',
        {class: 'pf-hde-view-content pf-hde-flamegraph-view'},
        legend,
        incomplete !== undefined &&
          incomplete.isIncomplete &&
          !incomplete.dismissed &&
          incompleteFlamegraphModal(attrs.trace, () => {
            incomplete.dismissed = true;
          }),
        m(FlamegraphPanel, {
          trace: attrs.trace,
          metrics,
          state,
          onStateChange: attrs.onStateChange,
        }),
      );
    },
  };
};
