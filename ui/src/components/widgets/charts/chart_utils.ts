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

import type {AggregateFunction} from '../datagrid/model';

/**
 * Aggregation functions available for charts.
 * Extends the datagrid's AggregateFunction with COUNT, which is
 * field-independent (counts rows rather than aggregating a column).
 */
export type ChartAggregation = AggregateFunction | 'COUNT';

/**
 * Format a number for display on chart axes.
 */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, {maximumFractionDigits: 0});
  }
  if (Math.abs(value) >= 1) {
    return value.toLocaleString(undefined, {maximumFractionDigits: 2});
  }
  // For very small numbers, use more precision
  return value.toPrecision(3);
}

/**
 * Whether an aggregation always produces integer results.
 */
export function isIntegerAggregation(agg: ChartAggregation): boolean {
  return agg === 'COUNT' || agg === 'COUNT_DISTINCT';
}

/**
 * Compute the p-th percentile of a numeric array using linear interpolation.
 * Returns NaN for empty arrays.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ---------------------------------------------------------------------------
// SQL helpers shared across chart loaders
// ---------------------------------------------------------------------------

// Valid SQL column name: identifier chars only (letters, digits, underscore).
const VALID_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe SQL column identifier.
 * Throws if the name contains non-identifier characters.
 */
export function validateColumnName(name: string): void {
  if (!VALID_COLUMN_RE.test(name)) {
    throw new Error(`Invalid SQL column name: '${name}'`);
  }
}
