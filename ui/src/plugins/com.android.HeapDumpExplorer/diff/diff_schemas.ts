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

// Cell renderers and `SchemaRegistry` factories for diff views.
//
// Visual weight is intentionally low: same plain-text treatment AHAT uses.
// Colour carries direction; aria-label carries the sign in words so colour
// isn't the only cue.
//
// Convention:
//   +Δ (current > baseline) → --pf-color-danger,  leading "+"  (grew)
//   −Δ (current < baseline) → --pf-color-success, leading "−"  (shrank)
//    Δ = 0                  → --pf-color-text-muted, "0"
//
// Status column renders as plain coloured uppercase text (no pill, no bold).
// Filterable through DataGrid's built-in column filter.
//   GREW      → --pf-color-danger
//   SHRANK    → --pf-color-success
//   NEW       → --pf-color-warning (it wasn't there; potential leak)
//   REMOVED   → --pf-color-text-muted
//   UNCHANGED → blank cell

import m from 'mithril';
import type {
  CellRenderResult,
  CellRenderer,
  ColumnDef,
  SchemaRegistry,
} from '../../../components/widgets/datagrid/datagrid_schema';
import type {SqlValue} from '../../../trace_processor/query_result';
import {fmtSize} from '../format';
import type {DiffStatus, Num} from './diff_rows';
import {
  KEY_COL,
  STATUS_COL,
  baselineCol,
  currentCol,
  deltaCol,
} from './diff_rows';

const STATUS_LABEL: Record<DiffStatus, string> = {
  NEW: 'NEW',
  REMOVED: 'REMOVED',
  GREW: 'GREW',
  SHRANK: 'SHRANK',
  UNCHANGED: '',
};

const STATUS_COLOUR: Record<DiffStatus, string> = {
  NEW: 'var(--pf-color-warning)',
  REMOVED: 'var(--pf-color-text-muted)',
  GREW: 'var(--pf-color-danger)',
  SHRANK: 'var(--pf-color-success)',
  UNCHANGED: 'var(--pf-color-text-hint)',
};

/**
 * Renders the Status column as plain coloured uppercase text. No chip, no
 * pill, no bold. Filterable through the column's built-in distinct-values
 * filter (right-click the column header).
 */
export const statusRenderer: CellRenderer = (
  value: SqlValue,
): CellRenderResult => {
  const s = String(value ?? 'UNCHANGED') as DiffStatus;
  const label = STATUS_LABEL[s] ?? s;
  if (label === '') {
    return {content: m('span'), align: 'left'};
  }
  return {
    content: m(
      'span',
      {
        'style': {
          'color': STATUS_COLOUR[s] ?? 'inherit',
          'font-size': '0.75rem',
          'letter-spacing': '0.04em',
        },
        'aria-label': `Status: ${label}`,
      },
      label,
    ),
    align: 'left',
  };
};

/**
 * Renders a delta size value in bytes. Positive deltas in red ("+1.2 MB",
 * memory grew), negative in green ("−340 KB", memory shrank).
 */
export const deltaSizeRenderer: CellRenderer = (
  value: SqlValue,
): CellRenderResult => {
  return renderDelta(value, (n) => fmtSize(Number(n)));
};

/** Renders a delta count value. Same colour convention as size. */
export const deltaCountRenderer: CellRenderer = (
  value: SqlValue,
): CellRenderResult => {
  return renderDelta(value, (n) => Math.abs(Number(n)).toLocaleString());
};

function renderDelta(
  value: SqlValue,
  fmtMagnitude: (n: Num) => string,
): CellRenderResult {
  const n = toNum(value);
  if (n == null) {
    return {
      content: m('span', {class: 'ah-mono ah-muted'}, '—'),
      align: 'right',
    };
  }
  const sign = compareToZero(n);
  if (sign === 0) {
    return {
      content: m(
        'span',
        {'class': 'ah-mono ah-muted', 'aria-label': 'No change'},
        '0',
      ),
      align: 'right',
    };
  }
  const symbol = sign > 0 ? '+' : '−';
  const colour =
    sign > 0 ? 'var(--pf-color-danger)' : 'var(--pf-color-success)';
  const word = sign > 0 ? 'increased by' : 'decreased by';
  const magnitude = fmtMagnitude(absNum(n));
  return {
    content: m(
      'span',
      {
        'class': 'ah-mono',
        'style': {color: colour},
        'aria-label': `${word} ${magnitude}`,
      },
      `${symbol}${magnitude}`,
    ),
    align: 'right',
  };
}

/**
 * Renders a per-side size value. null → "—" so empty cells are visible
 * (the row has the column on the other side).
 */
export const sideSizeRenderer: CellRenderer = (
  value: SqlValue,
): CellRenderResult => {
  const n = toNum(value);
  if (n == null) {
    return {
      content: m('span', {class: 'ah-mono ah-muted'}, '—'),
      align: 'right',
    };
  }
  return {
    content: m('span', {class: 'ah-mono'}, fmtSize(Number(n))),
    align: 'right',
  };
};

/** Per-side count. */
export const sideCountRenderer: CellRenderer = (
  value: SqlValue,
): CellRenderResult => {
  const n = toNum(value);
  if (n == null) {
    return {
      content: m('span', {class: 'ah-mono ah-muted'}, '—'),
      align: 'right',
    };
  }
  return {
    content: m('span', {class: 'ah-mono'}, Number(n).toLocaleString()),
    align: 'right',
  };
};

function toNum(v: SqlValue): Num | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function compareToZero(n: Num): number {
  if (typeof n === 'bigint') return n < 0n ? -1 : n > 0n ? 1 : 0;
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function absNum(n: Num): Num {
  if (typeof n === 'bigint') return n < 0n ? -n : n;
  return Math.abs(n);
}

/** Build a schema for a "key + size + count" diff view (Classes, Strings…). */
export function buildSizeCountSchema(opts: {
  /** The key column display title. e.g. "Class". */
  readonly keyTitle: string;
  /** Custom renderer for the key cell (e.g. clickable nav link). */
  readonly keyRenderer?: CellRenderer;
  /** Numeric size field name (matches the field passed to mergeRows). */
  readonly sizeField: string;
  /** Numeric count field name. */
  readonly countField: string;
  /** Optional secondary numeric fields (rendered as side-by-side). */
  readonly extraNumericFields?: ReadonlyArray<{
    readonly field: string;
    readonly title: string;
    readonly kind: 'size' | 'count';
  }>;
}): SchemaRegistry {
  const cols: Record<string, ColumnDef> = {
    [KEY_COL]: {
      title: opts.keyTitle,
      columnType: 'text',
      cellRenderer: opts.keyRenderer,
    },
    [STATUS_COL]: {
      title: 'Status',
      columnType: 'text',
      cellRenderer: statusRenderer,
    },
    [deltaCol(opts.sizeField)]: {
      title: 'Δ ' + opts.sizeField,
      columnType: 'quantitative',
      cellRenderer: deltaSizeRenderer,
    },
    [baselineCol(opts.sizeField)]: {
      title: 'Baseline ' + opts.sizeField,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    },
    [currentCol(opts.sizeField)]: {
      title: 'Current ' + opts.sizeField,
      columnType: 'quantitative',
      cellRenderer: sideSizeRenderer,
    },
    [deltaCol(opts.countField)]: {
      title: 'Δ ' + opts.countField,
      columnType: 'quantitative',
      cellRenderer: deltaCountRenderer,
    },
    [baselineCol(opts.countField)]: {
      title: 'Baseline ' + opts.countField,
      columnType: 'quantitative',
      cellRenderer: sideCountRenderer,
    },
    [currentCol(opts.countField)]: {
      title: 'Current ' + opts.countField,
      columnType: 'quantitative',
      cellRenderer: sideCountRenderer,
    },
  };
  for (const ef of opts.extraNumericFields ?? []) {
    const renderer = ef.kind === 'size' ? sideSizeRenderer : sideCountRenderer;
    const dRenderer =
      ef.kind === 'size' ? deltaSizeRenderer : deltaCountRenderer;
    cols[deltaCol(ef.field)] = {
      title: 'Δ ' + ef.title,
      columnType: 'quantitative',
      cellRenderer: dRenderer,
    };
    cols[baselineCol(ef.field)] = {
      title: 'Baseline ' + ef.title,
      columnType: 'quantitative',
      cellRenderer: renderer,
    };
    cols[currentCol(ef.field)] = {
      title: 'Current ' + ef.title,
      columnType: 'quantitative',
      cellRenderer: renderer,
    };
  }
  return {query: cols};
}

/** The default initial-column ordering for a size/count diff schema. */
export function buildSizeCountInitialColumns(opts: {
  readonly sizeField: string;
  readonly countField: string;
  readonly extraNumericFields?: ReadonlyArray<{readonly field: string}>;
}): Array<{id: string; field: string; sort?: 'ASC' | 'DESC'}> {
  const cols: Array<{id: string; field: string; sort?: 'ASC' | 'DESC'}> = [
    {id: KEY_COL, field: KEY_COL},
    {id: STATUS_COL, field: STATUS_COL},
    {
      id: deltaCol(opts.sizeField),
      field: deltaCol(opts.sizeField),
      sort: 'DESC',
    },
    {id: baselineCol(opts.sizeField), field: baselineCol(opts.sizeField)},
    {id: currentCol(opts.sizeField), field: currentCol(opts.sizeField)},
    {id: deltaCol(opts.countField), field: deltaCol(opts.countField)},
    {id: baselineCol(opts.countField), field: baselineCol(opts.countField)},
    {id: currentCol(opts.countField), field: currentCol(opts.countField)},
  ];
  for (const ef of opts.extraNumericFields ?? []) {
    cols.push({id: deltaCol(ef.field), field: deltaCol(ef.field)});
    cols.push({id: baselineCol(ef.field), field: baselineCol(ef.field)});
    cols.push({id: currentCol(ef.field), field: currentCol(ef.field)});
  }
  return cols;
}
