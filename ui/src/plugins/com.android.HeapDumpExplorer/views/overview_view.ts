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

// Overview tab. Five DataGrid cards. When `baselineOverview` is present
// each card gains Baseline / Current / Δ columns merged via mergeRows.

import m from 'mithril';
import type {SqlValue, Row} from '../../../trace_processor/query_result';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {
  CellRenderer,
  CellRenderResult,
  ColumnDef,
  SchemaRegistry,
} from '../../../components/widgets/datagrid/datagrid_schema';
import {Callout} from '../../../widgets/callout';
import {Intent} from '../../../widgets/common';
import type {OverviewData, HeapInfo} from '../types';
import {fmtSize} from '../format';
import type {NavState} from '../nav_state';
import {type NavFn, sizeRenderer, countRenderer} from '../components';
import {getLoadState} from '../baseline/load_action';
import {openBaselineFilePicker, shouldShowBaselineHeader} from '../header';
import {Button, ButtonVariant} from '../../../widgets/button';
import {
  baselineCol,
  currentCol,
  dedupeByKey,
  deltaCol,
  mergeRows,
  KEY_COL,
  STATUS_COL,
} from '../diff/diff_rows';
import {
  deltaCountRenderer,
  deltaSizeRenderer,
  sideCountRenderer,
  sideSizeRenderer,
  statusRenderer,
} from '../diff/diff_schemas';

interface OverviewViewAttrs {
  readonly overview: OverviewData;
  /**
   * True when a baseline is selected (mode is diff). The heading flips even
   * before the baseline overview query resolves so the user sees that the
   * page is in diff mode immediately.
   */
  readonly diffActive: boolean;
  /** When present → render diff columns alongside current values. */
  readonly baselineOverview?: OverviewData;
  /**
   * True when a baseline is loaded but its overview query is still running
   * (so diff columns are coming, not absent).
   */
  readonly baselineLoading?: boolean;
  readonly navigate: NavFn;
}

function OverviewView(): m.Component<OverviewViewAttrs> {
  return {
    view(vnode) {
      const {
        overview,
        diffActive,
        baselineOverview,
        baselineLoading,
        navigate,
      } = vnode.attrs;
      const isDiff = baselineOverview !== undefined;
      const heading = diffActive ? 'Overview diff' : 'Overview';
      // Mode tag baked into every card's vnode key. DataGrid captures its
      // `initialColumns` only on `oninit`, so we must force a remount when
      // we flip between the single-engine and diff column sets.
      const mode = isDiff ? 'diff' : 'single';

      // Mithril requires sibling vnodes in a fragment to either all have
      // keys or none. Wrap each top-level child in a keyed div so we can
      // freely use keys on individual cards (force-remount on mode flip)
      // without triggering "all-or-none keys" runtime errors.
      const child = (key: string, content: m.Children): m.Vnode =>
        m('div', {key}, content);

      return m('div', {class: 'ah-view-scroll'}, [
        child('heading', m('h2', {class: 'ah-view-heading'}, heading)),
        child('load', renderLoadBaselineSection()),
        child(
          'loading',
          baselineLoading === true && !isDiff
            ? m(
                Callout,
                {
                  icon: 'hourglass_empty',
                  intent: Intent.None,
                  className: 'ah-mb-4',
                  role: 'status',
                },
                'Computing baseline overview… diff columns will appear once it finishes.',
              )
            : null,
        ),
        child(`info-${mode}`, renderInfoCard(overview, baselineOverview)),
        child(`heaps-${mode}`, renderHeapsCard(overview, baselineOverview)),
        child(
          `bitmaps-${mode}`,
          renderDuplicateBitmapsCard(overview, baselineOverview, navigate),
        ),
        child(
          `strings-${mode}`,
          renderDuplicateStringsCard(overview, baselineOverview, navigate),
        ),
        child(
          `arrays-${mode}`,
          renderDuplicateArraysCard(overview, baselineOverview, navigate),
        ),
      ]);
    },
  };
}

// ----- Top-of-tab "Load baseline" affordance -------------------------------
//
// Only rendered in single-engine mode. When a baseline IS loaded, the slim
// header above the tabs holds the controls — no need to repeat them here.

function renderLoadBaselineSection(): m.Children {
  // The Overview-tab CTA is the discovery entry point for diff mode in the
  // common single-trace, no-diff workflow. Once the top bar is showing
  // baseline state (a load is in flight, an error needs reading, or a
  // pool / active baseline exists) the row's selector takes over and the
  // CTA collapses to keep the page free of duplicated affordances.
  if (shouldShowBaselineHeader()) return null;
  const {error} = getLoadState();
  // Bare button + helper text; we deliberately don't wrap in a Callout
  // here because the Callout's leading icon collides visually with the
  // button's `difference` icon (two adjacent glyphs reading the same).
  return [
    m(
      'div',
      {class: 'ah-heading-row ah-mb-4'},
      m(Button, {
        label: 'Diff against another trace…',
        icon: 'difference',
        intent: Intent.Primary,
        variant: ButtonVariant.Filled,
        onclick: () => openBaselineFilePicker(),
      }),
      m(
        'span',
        {class: 'ah-muted'},
        'Pick a .pftrace or .hprof; its dumps will appear in the ' +
          'baseline selector at the top.',
      ),
    ),
    error &&
      m(
        Callout,
        {
          icon: 'error',
          intent: Intent.Danger,
          role: 'alert',
          className: 'ah-mb-4',
        },
        error,
      ),
  ];
}

// ----- General Information --------------------------------------------------

function renderInfoCard(
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
): m.Children {
  if (baselineOverview === undefined) {
    const rows: Row[] = [
      {
        property: 'Reachable instances',
        value: overview.instanceCount.toLocaleString(),
      },
      {
        property: 'Heaps',
        value: overview.heaps.map((h) => h.name).join(', '),
      },
    ];
    const schema: SchemaRegistry = {
      query: {
        property: {title: 'Property', columnType: 'text'},
        value: {title: 'Value', columnType: 'text'},
      },
    };
    return m('div', {class: 'ah-card ah-mb-4'}, [
      m('h3', {class: 'ah-sub-heading'}, 'General Information'),
      m(DataGrid, {
        schema,
        rootSchema: 'query',
        data: rows,
        initialColumns: [
          {id: 'property', field: 'property'},
          {id: 'value', field: 'value'},
        ],
      }),
    ]);
  }

  const rows: Row[] = [
    {
      property: 'Reachable instances',
      baseline: baselineOverview.instanceCount,
      current: overview.instanceCount,
      delta: overview.instanceCount - baselineOverview.instanceCount,
    },
    {
      property: 'Heaps',
      baseline: baselineOverview.heaps.map((h) => h.name).join(', '),
      current: overview.heaps.map((h) => h.name).join(', '),
      delta: heapDeltaSummary(overview.heaps, baselineOverview.heaps),
    },
  ];
  const schema: SchemaRegistry = {
    query: {
      property: {title: 'Property', columnType: 'text'},
      baseline: {
        title: 'Baseline',
        columnType: 'text',
        cellRenderer: maybeNumericRenderer,
      },
      current: {
        title: 'Current',
        columnType: 'text',
        cellRenderer: maybeNumericRenderer,
      },
      delta: {
        title: 'Δ',
        columnType: 'text',
        cellRenderer: maybeDeltaCountRenderer,
      },
    },
  };
  return m('div', {class: 'ah-card ah-mb-4'}, [
    m('h3', {class: 'ah-sub-heading'}, 'General Information'),
    m(DataGrid, {
      schema,
      rootSchema: 'query',
      data: rows,
      initialColumns: [
        {id: 'property', field: 'property'},
        {id: 'baseline', field: 'baseline'},
        {id: 'current', field: 'current'},
        {id: 'delta', field: 'delta'},
      ],
    }),
  ]);
}

const maybeNumericRenderer: CellRenderer = (value: SqlValue) => {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return countRenderer(value);
  }
  return {
    content: m('span', String(value ?? '')),
    align: 'left',
  } satisfies CellRenderResult;
};

const maybeDeltaCountRenderer: CellRenderer = (value: SqlValue, row: Row) => {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return deltaCountRenderer(value, row);
  }
  return {
    content: m('span', {class: 'ah-muted'}, String(value ?? '')),
    align: 'left',
  } satisfies CellRenderResult;
};

function heapDeltaSummary(current: HeapInfo[], baseline: HeapInfo[]): string {
  const cSet = new Set(current.map((h) => h.name));
  const bSet = new Set(baseline.map((h) => h.name));
  const added = [...cSet].filter((h) => !bSet.has(h));
  const removed = [...bSet].filter((h) => !cSet.has(h));
  if (added.length === 0 && removed.length === 0) return 'same';
  const parts: string[] = [];
  if (added.length) parts.push(`+${added.join(', ')}`);
  if (removed.length) parts.push(`−${removed.join(', ')}`);
  return parts.join('; ');
}

// ----- Bytes retained by heap ----------------------------------------------

function renderHeapsCard(
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
): m.Children {
  // Only show heaps with non-zero retention on at least one side.
  const filterNonZero = (heaps: HeapInfo[]) =>
    heaps.filter((h) => h.java + h.native_ > 0);
  const cHeaps = filterNonZero(overview.heaps);

  if (baselineOverview === undefined) {
    const rows: Row[] = withTotalRow(
      cHeaps.map((h) => ({
        heap: h.name,
        java_size: h.java,
        native_size: h.native_,
        total_size: h.java + h.native_,
      })),
      'heap',
    );
    return m('div', {class: 'ah-card ah-mb-4'}, [
      m('h3', {class: 'ah-sub-heading'}, 'Bytes Retained by Heap'),
      m(DataGrid, {
        schema: {
          query: {
            heap: {title: 'Heap', columnType: 'text'},
            java_size: {
              title: 'Java',
              columnType: 'quantitative',
              cellRenderer: sizeRenderer,
            },
            native_size: {
              title: 'Native',
              columnType: 'quantitative',
              cellRenderer: sizeRenderer,
            },
            total_size: {
              title: 'Total',
              columnType: 'quantitative',
              cellRenderer: sizeRenderer,
            },
          },
        },
        rootSchema: 'query',
        data: rows,
        initialColumns: [
          {id: 'heap', field: 'heap'},
          {id: 'java_size', field: 'java_size'},
          {id: 'native_size', field: 'native_size'},
          {id: 'total_size', field: 'total_size'},
        ],
      }),
    ]);
  }

  const bHeaps = filterNonZero(baselineOverview.heaps);
  const merged = mergeRows({
    baseline: bHeaps.map((h) => ({
      heap: h.name,
      java_size: h.java,
      native_size: h.native_,
      total_size: h.java + h.native_,
    })),
    current: cHeaps.map((h) => ({
      heap: h.name,
      java_size: h.java,
      native_size: h.native_,
      total_size: h.java + h.native_,
    })),
    keyOf: (r) => String(r.heap ?? ''),
    numericFields: ['java_size', 'native_size', 'total_size'],
    primaryDeltaField: 'total_size',
  });
  // Rename the merged-row 'key' column to 'heap' for the schema.
  const dataRows: Row[] = merged.map((r) => ({...r, heap: r[KEY_COL]}));
  const schema = buildHeapsDiffSchema();
  return m('div', {class: 'ah-card ah-mb-4'}, [
    m('h3', {class: 'ah-sub-heading'}, 'Bytes Retained by Heap'),
    m(DataGrid, {
      schema,
      rootSchema: 'query',
      data: dataRows,
      initialColumns: [
        {id: 'heap', field: 'heap'},
        {id: STATUS_COL, field: STATUS_COL},
        {
          id: deltaCol('total_size'),
          field: deltaCol('total_size'),
          sort: 'DESC',
        },
        {id: baselineCol('total_size'), field: baselineCol('total_size')},
        {id: currentCol('total_size'), field: currentCol('total_size')},
        {id: deltaCol('java_size'), field: deltaCol('java_size')},
        {id: baselineCol('java_size'), field: baselineCol('java_size')},
        {id: currentCol('java_size'), field: currentCol('java_size')},
        {id: deltaCol('native_size'), field: deltaCol('native_size')},
        {id: baselineCol('native_size'), field: baselineCol('native_size')},
        {id: currentCol('native_size'), field: currentCol('native_size')},
      ],
    }),
  ]);
}

function buildHeapsDiffSchema(): SchemaRegistry {
  const cols: Record<string, ColumnDef> = {
    heap: {title: 'Heap', columnType: 'text'},
    [STATUS_COL]: {
      title: 'Status',
      columnType: 'text',
      cellRenderer: statusRenderer,
    },
  };
  const fields: Array<{field: string; title: string}> = [
    {field: 'total_size', title: 'Total'},
    {field: 'java_size', title: 'Java'},
    {field: 'native_size', title: 'Native'},
  ];
  for (const f of fields) {
    cols[deltaCol(f.field)] = {
      title: 'Δ ' + f.title,
      columnType: 'quantitative',
      cellRenderer: deltaSizeRenderer,
    };
    cols[baselineCol(f.field)] = {
      title: 'Baseline ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    };
    cols[currentCol(f.field)] = {
      title: 'Current ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    };
  }
  return {query: cols};
}

function withTotalRow<T extends Row>(rows: T[], keyField: keyof T): Row[] {
  if (rows.length === 0) return rows;
  const total: Row = {[keyField as string]: 'Total'};
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (k === keyField) continue;
      const v = r[k];
      if (typeof v === 'number') {
        total[k] = ((total[k] as number | undefined) ?? 0) + v;
      }
    }
  }
  return [total, ...rows];
}

// ----- Duplicate sections ---------------------------------------------------

function renderDuplicateBitmapsCard(
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
  navigate: NavFn,
): m.Children {
  const cur = overview.duplicateBitmaps ?? [];
  const base = baselineOverview?.duplicateBitmaps ?? [];
  if (cur.length === 0 && base.length === 0 && !overview.hasFieldValues) {
    return null;
  }
  if (cur.length === 0 && base.length === 0) {
    return m(
      'div',
      {class: 'ah-card ah-mb-4'},
      m('p', {class: 'ah-muted'}, 'No duplicate bitmaps found.'),
    );
  }
  const isDiff = baselineOverview !== undefined;
  const summary = makeSummary('group', cur, base, (g) => g.wastedBytes, isDiff);

  if (!isDiff) {
    return renderDuplicateSectionSingle({
      title: 'Duplicate Bitmaps',
      summary,
      targetView: 'bitmaps',
      linkLabel: 'View Bitmaps',
      navigate,
      data: cur.map((g) => ({
        dimensions: `${g.width} × ${g.height}`,
        groupKey: g.groupKey,
        copies: g.count,
        total_bytes: g.totalBytes,
        wasted_bytes: g.wastedBytes,
      })),
      schema: {
        query: {
          dimensions: {title: 'Dimensions', columnType: 'text'},
          groupKey: {title: 'Hash', columnType: 'text'},
          copies: {
            title: 'Copies',
            columnType: 'quantitative',
            cellRenderer: makeNavCountRenderer((row) =>
              navigate('bitmaps', {filterKey: String(row.groupKey ?? '')}),
            ),
          },
          total_bytes: {
            title: 'Total',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
          wasted_bytes: {
            title: 'Wasted',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
        },
      },
      initialColumns: [
        {id: 'dimensions', field: 'dimensions'},
        {id: 'groupKey', field: 'groupKey'},
        {id: 'copies', field: 'copies'},
        {id: 'total_bytes', field: 'total_bytes'},
        {id: 'wasted_bytes', field: 'wasted_bytes'},
      ],
    });
  }

  // Diff variant. Outer-join on groupKey.
  const bitmapNumericFields = ['copies', 'total_bytes', 'wasted_bytes'];
  const baseRows = dedupeByKey(
    base.map((g) => ({
      key: g.groupKey,
      dimensions: `${g.width} × ${g.height}`,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    bitmapNumericFields,
  );
  const curRows = dedupeByKey(
    cur.map((g) => ({
      key: g.groupKey,
      dimensions: `${g.width} × ${g.height}`,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    bitmapNumericFields,
  );
  const merged = mergeRows({
    baseline: baseRows,
    current: curRows,
    keyOf: (r) => String(r.key),
    numericFields: bitmapNumericFields,
    passThroughFields: ['dimensions'],
    primaryDeltaField: 'wasted_bytes',
  });
  return renderDuplicateSectionDiff({
    title: 'Duplicate Bitmaps',
    summary,
    targetView: 'bitmaps',
    linkLabel: 'View Bitmaps diff',
    navigate,
    data: merged.map((r) => ({...r, groupKey: r[KEY_COL]})),
    keyTitle: 'Hash',
    keyField: 'groupKey',
    extraTextFields: [{field: 'dimensions', title: 'Dimensions'}],
    sizeFields: [
      {field: 'wasted_bytes', title: 'Wasted'},
      {field: 'total_bytes', title: 'Total'},
    ],
    countFields: [{field: 'copies', title: 'Copies'}],
    primarySortField: 'wasted_bytes',
  });
}

function renderDuplicateStringsCard(
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
  navigate: NavFn,
): m.Children {
  const cur = overview.duplicateStrings ?? [];
  const base = baselineOverview?.duplicateStrings ?? [];
  if (cur.length === 0 && base.length === 0 && !overview.hasFieldValues) {
    return null;
  }
  if (cur.length === 0 && base.length === 0) {
    return m(
      'div',
      {class: 'ah-card ah-mb-4'},
      m('p', {class: 'ah-muted'}, 'No duplicate strings found.'),
    );
  }
  const isDiff = baselineOverview !== undefined;
  const summary = makeSummary('group', cur, base, (g) => g.wastedBytes, isDiff);

  if (!isDiff) {
    return renderDuplicateSectionSingle({
      title: 'Duplicate Strings',
      summary,
      targetView: 'strings',
      linkLabel: 'View Strings',
      navigate,
      data: cur.map((g) => ({
        value: g.value,
        copies: g.count,
        total_bytes: g.totalBytes,
        wasted_bytes: g.wastedBytes,
      })),
      schema: {
        query: {
          value: {
            title: 'Value',
            columnType: 'text',
            cellRenderer: makeStringRenderer((row) =>
              navigate('strings', {q: String(row.value ?? '')}),
            ),
          },
          copies: {
            title: 'Copies',
            columnType: 'quantitative',
            cellRenderer: makeNavCountRenderer((row) =>
              navigate('strings', {q: String(row.value ?? '')}),
            ),
          },
          total_bytes: {
            title: 'Total',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
          wasted_bytes: {
            title: 'Wasted',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
        },
      },
      initialColumns: [
        {id: 'value', field: 'value'},
        {id: 'copies', field: 'copies'},
        {id: 'total_bytes', field: 'total_bytes'},
        {id: 'wasted_bytes', field: 'wasted_bytes'},
      ],
    });
  }

  const stringNumericFields = ['copies', 'total_bytes', 'wasted_bytes'];
  const baseRows = dedupeByKey(
    base.map((g) => ({
      key: g.value,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    stringNumericFields,
  );
  const curRows = dedupeByKey(
    cur.map((g) => ({
      key: g.value,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    stringNumericFields,
  );
  const merged = mergeRows({
    baseline: baseRows,
    current: curRows,
    keyOf: (r) => String(r.key),
    numericFields: stringNumericFields,
    primaryDeltaField: 'wasted_bytes',
  });
  return renderDuplicateSectionDiff({
    title: 'Duplicate Strings',
    summary,
    targetView: 'strings',
    linkLabel: 'View Strings diff',
    navigate,
    data: merged.map((r) => ({...r, value: r[KEY_COL]})),
    keyTitle: 'Value',
    keyField: 'value',
    keyRenderer: makeStringRenderer((row) =>
      navigate('strings', {q: String(row.value ?? '')}),
    ),
    extraTextFields: [],
    sizeFields: [
      {field: 'wasted_bytes', title: 'Wasted'},
      {field: 'total_bytes', title: 'Total'},
    ],
    countFields: [{field: 'copies', title: 'Copies'}],
    primarySortField: 'wasted_bytes',
  });
}

function renderDuplicateArraysCard(
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
  navigate: NavFn,
): m.Children {
  const cur = overview.duplicateArrays ?? [];
  const base = baselineOverview?.duplicateArrays ?? [];
  if (cur.length === 0 && base.length === 0) return null;
  const isDiff = baselineOverview !== undefined;
  const summary = makeSummary('group', cur, base, (g) => g.wastedBytes, isDiff);

  if (!isDiff) {
    return renderDuplicateSectionSingle({
      title: 'Duplicate Primitive Arrays',
      summary,
      targetView: 'arrays',
      linkLabel: 'View Arrays',
      navigate,
      data: cur.map((g) => ({
        className: g.className,
        arrayHash: g.arrayHash,
        copies: g.count,
        total_bytes: g.totalBytes,
        wasted_bytes: g.wastedBytes,
      })),
      schema: {
        query: {
          className: {
            title: 'Array Type',
            columnType: 'text',
            cellRenderer: (value: SqlValue) =>
              ({
                content: m(
                  'button',
                  {
                    class: 'ah-link',
                    onclick: () =>
                      navigate('objects', {cls: String(value ?? '')}),
                  },
                  String(value ?? ''),
                ),
                align: 'left',
              }) as CellRenderResult,
          },
          arrayHash: {title: 'Hash', columnType: 'text'},
          copies: {
            title: 'Copies',
            columnType: 'quantitative',
            cellRenderer: makeNavCountRenderer((row) =>
              navigate('arrays', {arrayHash: String(row.arrayHash ?? '')}),
            ),
          },
          total_bytes: {
            title: 'Total',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
          wasted_bytes: {
            title: 'Wasted',
            columnType: 'quantitative',
            cellRenderer: sizeRenderer,
          },
        },
      },
      initialColumns: [
        {id: 'className', field: 'className'},
        {id: 'arrayHash', field: 'arrayHash'},
        {id: 'copies', field: 'copies'},
        {id: 'total_bytes', field: 'total_bytes'},
        {id: 'wasted_bytes', field: 'wasted_bytes'},
      ],
    });
  }

  const arrayNumericFields = ['copies', 'total_bytes', 'wasted_bytes'];
  const baseRows = dedupeByKey(
    base.map((g) => ({
      key: g.arrayHash,
      className: g.className,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    arrayNumericFields,
  );
  const curRows = dedupeByKey(
    cur.map((g) => ({
      key: g.arrayHash,
      className: g.className,
      copies: g.count,
      total_bytes: g.totalBytes,
      wasted_bytes: g.wastedBytes,
    })),
    (r) => String(r.key),
    arrayNumericFields,
  );
  const merged = mergeRows({
    baseline: baseRows,
    current: curRows,
    keyOf: (r) => String(r.key),
    numericFields: arrayNumericFields,
    passThroughFields: ['className'],
    primaryDeltaField: 'wasted_bytes',
  });
  return renderDuplicateSectionDiff({
    title: 'Duplicate Primitive Arrays',
    summary,
    targetView: 'arrays',
    linkLabel: 'View Arrays diff',
    navigate,
    data: merged.map((r) => ({...r, arrayHash: r[KEY_COL]})),
    keyTitle: 'Hash',
    keyField: 'arrayHash',
    extraTextFields: [{field: 'className', title: 'Array Type'}],
    sizeFields: [
      {field: 'wasted_bytes', title: 'Wasted'},
      {field: 'total_bytes', title: 'Total'},
    ],
    countFields: [{field: 'copies', title: 'Copies'}],
    primarySortField: 'wasted_bytes',
  });
}

// ----- Shared helpers for duplicate sections -------------------------------

interface SingleSectionOpts {
  readonly title: string;
  readonly summary: m.Children;
  readonly targetView: string;
  readonly linkLabel: string;
  readonly navigate: NavFn;
  readonly data: Row[];
  readonly schema: SchemaRegistry;
  readonly initialColumns: Array<{id: string; field: string}>;
}

function renderDuplicateSectionSingle(opts: SingleSectionOpts): m.Children {
  return m('div', {class: 'ah-card ah-mb-4'}, [
    m('h3', {class: 'ah-sub-heading'}, opts.title),
    m('p', {class: 'ah-desc'}, [
      opts.summary,
      ' ',
      m(
        'button',
        {
          class: 'ah-link--alt',
          onclick: () => opts.navigate(opts.targetView as NavState['view']),
        },
        opts.linkLabel,
      ),
    ]),
    m(DataGrid, {
      schema: opts.schema,
      rootSchema: 'query',
      data: opts.data,
      initialColumns: opts.initialColumns,
    }),
  ]);
}

interface DiffSectionOpts {
  readonly title: string;
  readonly summary: m.Children;
  readonly targetView: string;
  readonly linkLabel: string;
  readonly navigate: NavFn;
  readonly data: Row[];
  readonly keyTitle: string;
  readonly keyField: string;
  readonly keyRenderer?: CellRenderer;
  readonly extraTextFields: ReadonlyArray<{field: string; title: string}>;
  readonly sizeFields: ReadonlyArray<{field: string; title: string}>;
  readonly countFields: ReadonlyArray<{field: string; title: string}>;
  /** Numeric field used for default sort by `|Δ|` desc. */
  readonly primarySortField: string;
}

function renderDuplicateSectionDiff(opts: DiffSectionOpts): m.Children {
  const cols: Record<string, ColumnDef> = {
    [opts.keyField]: {
      title: opts.keyTitle,
      columnType: 'text',
      cellRenderer: opts.keyRenderer,
    },
    [STATUS_COL]: {
      title: 'Status',
      columnType: 'text',
      cellRenderer: statusRenderer,
    },
  };
  for (const tf of opts.extraTextFields) {
    cols[tf.field] = {title: tf.title, columnType: 'text'};
  }
  for (const f of opts.sizeFields) {
    cols[deltaCol(f.field)] = {
      title: 'Δ ' + f.title,
      columnType: 'quantitative',
      cellRenderer: deltaSizeRenderer,
    };
    cols[baselineCol(f.field)] = {
      title: 'Baseline ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    };
    cols[currentCol(f.field)] = {
      title: 'Current ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    };
  }
  for (const f of opts.countFields) {
    cols[deltaCol(f.field)] = {
      title: 'Δ ' + f.title,
      columnType: 'quantitative',
      cellRenderer: deltaCountRenderer,
    };
    cols[baselineCol(f.field)] = {
      title: 'Baseline ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideCountRenderer,
    };
    cols[currentCol(f.field)] = {
      title: 'Current ' + f.title,
      columnType: 'quantitative',
      cellRenderer: sideCountRenderer,
    };
  }
  const initialColumns: Array<{
    id: string;
    field: string;
    sort?: 'ASC' | 'DESC';
  }> = [
    {id: opts.keyField, field: opts.keyField},
    {id: STATUS_COL, field: STATUS_COL},
  ];
  for (const tf of opts.extraTextFields) {
    initialColumns.push({id: tf.field, field: tf.field});
  }
  for (const f of [...opts.sizeFields, ...opts.countFields]) {
    if (f.field === opts.primarySortField) {
      initialColumns.push({
        id: deltaCol(f.field),
        field: deltaCol(f.field),
        sort: 'DESC',
      });
    } else {
      initialColumns.push({id: deltaCol(f.field), field: deltaCol(f.field)});
    }
    initialColumns.push({
      id: baselineCol(f.field),
      field: baselineCol(f.field),
    });
    initialColumns.push({id: currentCol(f.field), field: currentCol(f.field)});
  }
  return m('div', {class: 'ah-card ah-mb-4'}, [
    m('h3', {class: 'ah-sub-heading'}, opts.title),
    m('p', {class: 'ah-desc'}, [
      opts.summary,
      ' ',
      m(
        'button',
        {
          class: 'ah-link--alt',
          onclick: () => opts.navigate(opts.targetView as NavState['view']),
        },
        opts.linkLabel,
      ),
    ]),
    m(DataGrid, {
      schema: {query: cols},
      rootSchema: 'query',
      data: opts.data,
      initialColumns,
    }),
  ]);
}

function makeNavCountRenderer(onclick: (row: Row) => void): CellRenderer {
  return (value: SqlValue, row: Row): CellRenderResult => ({
    content: m(
      'button',
      {class: 'ah-link', onclick: () => onclick(row)},
      String(value ?? '0'),
    ),
    align: 'right',
  });
}

function makeStringRenderer(onclick: (row: Row) => void): CellRenderer {
  return (value: SqlValue, row: Row): CellRenderResult => {
    const s = String(value ?? '');
    const display = s.length > 200 ? s.slice(0, 200) + '…' : s;
    return {
      content: m(
        'button',
        {
          class: 'ah-link ah-mono ah-break-all ah-str-color',
          onclick: () => onclick(row),
        },
        '"' + display + '"',
      ),
      align: 'left',
    };
  };
}

interface DuplicateGroupLike {
  readonly wastedBytes: number;
}

function makeSummary<T extends DuplicateGroupLike>(
  unit: string,
  cur: ReadonlyArray<T>,
  base: ReadonlyArray<T>,
  wastedBytes: (g: T) => number,
  isDiff: boolean,
): m.Children {
  const cWasted = cur.reduce((a, g) => a + wastedBytes(g), 0);
  if (!isDiff) {
    return [
      cur.length +
        ' ' +
        unit +
        (cur.length !== 1 ? 's' : '') +
        ' detected, wasting ',
      m('span', {class: 'ah-mono ah-semibold'}, fmtSize(cWasted)),
      '.',
    ];
  }
  const bWasted = base.reduce((a, g) => a + wastedBytes(g), 0);
  const dWasted = cWasted - bWasted;
  const dGroups = cur.length - base.length;
  return [
    `${cur.length} ${unit}${cur.length !== 1 ? 's' : ''} `,
    m('span', {class: 'ah-mono'}, `(${dGroups >= 0 ? '+' : ''}${dGroups})`),
    ', wasting ',
    m('span', {class: 'ah-mono ah-semibold'}, fmtSize(cWasted)),
    ' ',
    m(
      'span',
      {
        class:
          'ah-mono ' +
          (dWasted > 0
            ? 'ah-delta--grew'
            : dWasted < 0
              ? 'ah-delta--shrank'
              : 'ah-delta--zero'),
      },
      `(${dWasted >= 0 ? '+' : '−'}${fmtSize(Math.abs(dWasted))})`,
    ),
    '.',
  ];
}

export default OverviewView;
