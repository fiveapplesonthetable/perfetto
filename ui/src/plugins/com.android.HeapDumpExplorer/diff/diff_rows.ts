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

// Pure JS-side row merge for diff views.
//
// Inputs:
//   - baseline rows (from one engine)
//   - current rows (from the other engine)
//   - keyOf: how to derive a comparable identity per row
//   - numericFields: column names whose Δ should be computed
//
// Output: one merged DiffRow per distinct key, with `_b_<col>`, `_c_<col>`,
// `_d_<col>` (delta), and a `status` enum.
//
// Why JS not SQL: trace_processor instances live in separate Web Workers
// with separate Wasm heaps; sqlite cannot ATTACH across workers, so a single
// cross-engine SQL JOIN is impossible. JS outer-join over ~20K × 20K rows
// runs in ~10ms — cheap.

import type {Row, SqlValue} from '../../../trace_processor/query_result';

/** Numeric column type — sqlite returns either depending on iter spec. */
export type Num = number | bigint;

/** Status badge values. Filterable via the Status header dropdown. */
export type DiffStatus = 'NEW' | 'REMOVED' | 'GREW' | 'SHRANK' | 'UNCHANGED';

/** Constant column names produced by `mergeRows`. */
export const KEY_COL = 'key';
export const STATUS_COL = 'status';
export const baselineCol = (field: string) => `_b_${field}`;
export const currentCol = (field: string) => `_c_${field}`;
export const deltaCol = (field: string) => `_d_${field}`;

export interface MergeOptions<T extends Row> {
  /** Rows from the baseline engine. Must have unique keys. */
  readonly baseline: readonly T[];
  /** Rows from the current engine. Must have unique keys. */
  readonly current: readonly T[];
  /** Derive the join key from a row. Stable string identity. */
  readonly keyOf: (row: T) => string;
  /** Numeric columns to diff. Each becomes _b_/_c_/_d_ in output. */
  readonly numericFields: readonly string[];
  /**
   * Optional non-numeric columns to copy through (preferring current side
   * when both sides have the row). E.g. an extra display label column.
   */
  readonly passThroughFields?: readonly string[];
  /**
   * Determines GREW/SHRANK vs UNCHANGED. Default: any non-zero delta on the
   * `primaryDeltaField` flips status. Pass a custom threshold (e.g. > 1024
   * bytes) for views where small wobble shouldn't move the needle.
   */
  readonly primaryDeltaField: string;
  /**
   * Optional status threshold. If |delta(primaryDeltaField)| <= threshold,
   * status is UNCHANGED even if non-zero. Defaults to 0.
   */
  readonly statusThreshold?: Num;
}

export interface DiffRow extends Row {
  readonly [KEY_COL]: string;
  readonly [STATUS_COL]: DiffStatus;
  readonly [field: string]: SqlValue;
}

/**
 * Outer-join `baseline` and `current` by `keyOf`. For each numeric field,
 * emits baseline / current / delta columns with the canonical names from
 * `baselineCol`/`currentCol`/`deltaCol`. Throws if either input has duplicate
 * keys (caller bug — both inputs should be already aggregated by the join key).
 */
export function mergeRows<T extends Row>(opts: MergeOptions<T>): DiffRow[] {
  const {
    baseline,
    current,
    keyOf,
    numericFields,
    passThroughFields = [],
    primaryDeltaField,
    statusThreshold,
  } = opts;

  if (!numericFields.includes(primaryDeltaField)) {
    throw new Error(
      `mergeRows: primaryDeltaField '${primaryDeltaField}' must be in numericFields`,
    );
  }

  const baselineMap = indexByKey(baseline, keyOf, 'baseline');
  const currentMap = indexByKey(current, keyOf, 'current');

  const allKeys = new Set<string>();
  for (const k of baselineMap.keys()) allKeys.add(k);
  for (const k of currentMap.keys()) allKeys.add(k);

  const result: DiffRow[] = [];
  for (const key of allKeys) {
    const b = baselineMap.get(key);
    const c = currentMap.get(key);

    const row: Record<string, SqlValue> = {
      [KEY_COL]: key,
      [STATUS_COL]: classify(b, c, primaryDeltaField, statusThreshold ?? 0),
    };

    for (const field of numericFields) {
      const bv = numericOrNull(b, field);
      const cv = numericOrNull(c, field);
      row[baselineCol(field)] = bv as SqlValue;
      row[currentCol(field)] = cv as SqlValue;
      row[deltaCol(field)] = delta(bv, cv) as SqlValue;
    }

    for (const field of passThroughFields) {
      // Prefer current side (the "is" view); fall back to baseline ("was").
      row[field] = (c?.[field] ?? b?.[field] ?? null) as SqlValue;
    }

    result.push(row as DiffRow);
  }

  return result;
}

/**
 * Compute b - a, normalising number / bigint mismatches. If either side is
 * bigint, both are coerced to bigint to preserve exact precision (heap sizes
 * can exceed 2^53). Treats null as 0 for arithmetic.
 */
export function delta(a: Num | null, b: Num | null): Num {
  if (a == null && b == null) return 0;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return toBigInt(b) - toBigInt(a);
  }
  return ((b as number) ?? 0) - ((a as number) ?? 0);
}

/** Absolute value preserving Num type. */
export function abs(v: Num): Num {
  if (typeof v === 'bigint') return v < 0n ? -v : v;
  return Math.abs(v);
}

/** Compare two Nums, returning -1 / 0 / 1. Handles mixed types. */
export function compareNum(a: Num | null, b: Num | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const ab = toBigInt(a);
    const bb = toBigInt(b);
    return ab < bb ? -1 : ab > bb ? 1 : 0;
  }
  const an = a as number;
  const bn = b as number;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function toBigInt(v: Num | null): bigint {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  if (Number.isInteger(v)) return BigInt(v);
  // Truncate non-integer floats. Heap sizes are always integers so this
  // shouldn't occur in practice; throwing would be more honest but the
  // sqlite NUM iter sometimes returns float-typed-but-integer-valued
  // numbers, so we allow truncation.
  return BigInt(Math.trunc(v));
}

function numericOrNull(row: Row | undefined, field: string): Num | null {
  if (!row) return null;
  const v = row[field];
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  // Defensive: sqlite occasionally surfaces stringified ints. Try to parse.
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Collapse duplicate-keyed rows by summing the listed numeric fields.
 * Non-numeric columns are kept from the first occurrence. Use this before
 * `mergeRows` when SQL GROUP BY can't fully unique-ify the join key (e.g.
 * `type_name` when multiple `type_id`s share the same display name across
 * classloaders, or a hash field whose collisions are semantically equivalent
 * for the user). Cheap: O(n) over the input.
 */
export function dedupeByKey<T extends Row>(
  rows: readonly T[],
  keyOf: (r: T) => string,
  numericFields: readonly string[],
): T[] {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = keyOf(r);
    const existing = map.get(k);
    if (existing === undefined) {
      map.set(k, {...r});
      continue;
    }
    const merged = existing as Record<string, SqlValue>;
    for (const f of numericFields) {
      const a = numericOrNull(existing, f);
      const b = numericOrNull(r, f);
      if (a == null && b == null) {
        merged[f] = null;
      } else if (typeof a === 'bigint' || typeof b === 'bigint') {
        merged[f] = (toBigInt(a) + toBigInt(b)) as SqlValue;
      } else {
        merged[f] = ((a ?? 0) as number) + ((b ?? 0) as number);
      }
    }
  }
  return Array.from(map.values());
}

function indexByKey<T extends Row>(
  rows: readonly T[],
  keyOf: (r: T) => string,
  side: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = keyOf(r);
    if (map.has(k)) {
      throw new Error(
        `mergeRows: duplicate key '${k}' on ${side} side. Both inputs must ` +
          `be pre-aggregated by the join key.`,
      );
    }
    map.set(k, r);
  }
  return map;
}

function classify(
  b: Row | undefined,
  c: Row | undefined,
  field: string,
  threshold: Num,
): DiffStatus {
  // NEW/REMOVED is decided by *row presence* in the input, not by the value
  // of `primaryDeltaField`. Earlier we treated null-or-zero on one side as
  // "absent" — that misclassified classes that exist in both snapshots but
  // have e.g. dominated_size_bytes=0 in baseline (very common: many classes
  // are reachable but not dominators of anything substantial) as NEW.
  if (b === undefined && c === undefined) return 'UNCHANGED';
  if (b === undefined) return 'NEW';
  if (c === undefined) return 'REMOVED';
  const d = delta(numericOrNull(b, field), numericOrNull(c, field));
  if (compareAbs(d, threshold) <= 0) return 'UNCHANGED';
  return compareNum(d, 0) > 0 ? 'GREW' : 'SHRANK';
}

function compareAbs(a: Num, b: Num): number {
  return compareNum(abs(a), abs(b));
}

/**
 * Sort comparator for "biggest change first". Pass to Array.prototype.sort
 * to get rows ordered by `|delta(primaryDeltaField)|` descending, ties
 * broken by key. Used as the default sort in Classes/Strings/etc. diff views.
 */
export function compareByAbsDeltaDesc(
  primaryDeltaField: string,
): (a: DiffRow, b: DiffRow) => number {
  const col = deltaCol(primaryDeltaField);
  return (a, b) => {
    const av = a[col] as Num | null;
    const bv = b[col] as Num | null;
    const aa = av == null ? 0n : abs(av as Num);
    const bb = bv == null ? 0n : abs(bv as Num);
    const cmp = compareNum(bb, aa); // descending
    if (cmp !== 0) return cmp;
    // Stable tiebreaker on key.
    return String(a[KEY_COL]).localeCompare(String(b[KEY_COL]));
  };
}
