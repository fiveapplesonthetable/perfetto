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

// Per-trace state for the active heap-dump selection.
//
// A perfetto trace can contain multiple heap dumps — one per (process,
// graph_sample_ts) — when java_hprof is captured periodically or for
// several processes in the same recording. Without a selection the
// aggregating queries (Overview totals, Classes / Strings / Arrays /
// Bitmaps / Dominators tables) would silently sum across every dump and
// produce meaningless numbers.
//
// This module owns the list of dumps discovered in the current trace and
// the user's active selection. `gen` is bumped on every state transition
// (new trace, selection change, reset) so views can short-circuit
// in-flight queries that would render against a stale dump.

import m from 'mithril';

export interface HeapDump {
  /** Process upid as stored in heap_graph_object / process tables. */
  readonly upid: number;
  /**
   * Heap dump timestamp (graph_sample_ts). Stored as bigint because
   * timestamps can exceed 2^53 ns. Always a positive integer.
   */
  readonly ts: bigint;
  /**
   * Process name from `process.name` (kernel comm) or `process.cmdline` if
   * the trace contains process_stats. May be null when the dump was captured
   * via `java_hprof` without a co-recorded `linux.process_stats` data source
   * — common for ad-hoc captures. The selector renders just `pid <N>` in
   * that case to avoid the awkward `pid <N> (pid <N>)` redundancy.
   */
  readonly processName: string | null;
  /** Process id at dump time. Always present. */
  readonly pid: number;
}

let dumps: ReadonlyArray<HeapDump> = [];
let active: HeapDump | null = null;
let nextGen = 1;
let gen = 0;

/** Return the list of dumps discovered in the current trace, ordered by ts. */
export function getDumps(): ReadonlyArray<HeapDump> {
  return dumps;
}

/** Currently selected dump, or null if no trace is loaded. */
export function getActive(): HeapDump | null {
  return active;
}

/**
 * Generation counter. Incremented on every state transition (new trace,
 * selection change, reset). Long-running views capture `gen` before their
 * first await and abort if it changes — this prevents a slow query started
 * against the previous dump from clobbering the UI after the user selects
 * a different one.
 */
export function getGen(): number {
  return gen;
}

/** True if the captured generation still matches the live state. */
export function isGenStillValid(captured: number): boolean {
  return captured === gen;
}

/**
 * Replace the dump list and select the first one as active. Called by the
 * loader after a trace finishes loading. Always bumps `gen` even when the
 * new list is empty so that any in-flight view query is aborted cleanly.
 */
export function setDumps(newDumps: ReadonlyArray<HeapDump>): void {
  dumps = newDumps;
  active = newDumps.length > 0 ? newDumps[0] : null;
  gen = nextGen++;
  m.redraw();
}

/**
 * Set the user's active dump. Caller must pass a HeapDump from the current
 * `getDumps()` list — passing a stale reference is a programming error.
 * No-op if the dump is already active.
 */
export function setActive(d: HeapDump): void {
  if (active === d) return;
  if (!dumps.includes(d)) {
    throw new Error(
      `setActive: dump (upid=${d.upid}, ts=${d.ts}) is not in the current ` +
        `trace's dump list. setDumps() must be called first with this ` +
        `instance, or use one of the entries from getDumps().`,
    );
  }
  active = d;
  gen = nextGen++;
  m.redraw();
}

/** Clear all state. Called on plugin teardown / new trace load. */
export function reset(): void {
  dumps = [];
  active = null;
  gen = nextGen++;
  m.redraw();
}

/**
 * SQL fragment that filters `heap_graph_object` (or any join target with the
 * same upid / graph_sample_ts columns) to the active dump.
 *
 * Returns `1=1` when no dump is active so callers can splice the result into
 * an existing WHERE clause without worrying about the empty case — the empty
 * case is already handled by the caller (no engine queries fire before the
 * loader has populated state).
 */
export function dumpFilterSql(alias: string = 'o'): string {
  if (!active) return '1=1';
  return (
    `${alias}.upid = ${active.upid} ` +
    `AND ${alias}.graph_sample_ts = ${active.ts}`
  );
}
