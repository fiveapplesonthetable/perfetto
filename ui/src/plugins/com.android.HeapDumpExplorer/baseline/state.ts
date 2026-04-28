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

// Multi-trace baseline pool for diff mode.
//
// Diffing is multi-step. The user adds one or more baseline traces; each
// trace's dumps (one per (upid, graph_sample_ts) pair) are pooled together;
// the user then picks exactly one of those dumps as the active baseline.
// The diff views compare the active baseline dump against the active
// primary dump (the latter chosen via dumps/state.ts).
//
// Why a pool: a trace can hold multiple dumps, so loading a baseline trace
// cannot pick a baseline by itself. With multiple traces in flight the user
// also wants to switch baselines without re-uploading files. Each pooled
// trace owns its own WasmEngineProxy (spawned in a worker), so memory cost
// is one Wasm heap per trace — keep the pool small in practice.
//
// `gen` semantics: incremented on every state transition (add/remove/select
// /clear/dispose). Long-running views capture `gen` before their first
// await and abort if it changes — prevents a stale-trace query from
// clobbering the UI after the user switches baselines.

import m from 'mithril';
import type {WasmEngineProxy} from '../../../trace_processor/wasm_engine_proxy';
import type {HeapDump} from '../dumps/state';

/**
 * One loaded baseline trace. Each contributes 1+ dumps to the pool. The
 * engine is owned by this module — disposed on remove / new primary trace
 * / plugin teardown.
 */
export interface BaselineTrace {
  readonly id: string;
  readonly engine: WasmEngineProxy;
  readonly title: string;
  readonly dumps: ReadonlyArray<HeapDump>;
}

/** Pool entry: a (trace, dump) pair. Exposed for the selector. */
export interface BaselineDumpRef {
  readonly trace: BaselineTrace;
  readonly dump: HeapDump;
}

let traces: BaselineTrace[] = [];
let active: BaselineDumpRef | null = null;
let nextGen = 1;
let gen = 0;
let nextTraceId = 1;

export type DiffMode = 'diff' | 'current' | 'baseline';
let mode: DiffMode = 'diff';

// ---------------------------------------------------------------------------
// Read API.

/** All loaded baseline traces, in load order. */
export function getBaselineTraces(): ReadonlyArray<BaselineTrace> {
  return traces;
}

/** Flat list of (trace, dump) pairs across all traces. */
export function listBaselineDumps(): ReadonlyArray<BaselineDumpRef> {
  const out: BaselineDumpRef[] = [];
  for (const t of traces) {
    for (const d of t.dumps) out.push({trace: t, dump: d});
  }
  return out;
}

/** Currently selected (trace, dump), or null. */
export function getActiveBaseline(): BaselineDumpRef | null {
  return active;
}

export function getGen(): number {
  return gen;
}
export function isGenStillValid(captured: number): boolean {
  return captured === gen;
}

export function getMode(): DiffMode {
  return mode;
}
export function setMode(m: DiffMode): void {
  mode = m;
}

/** True iff the diff view should render right now. */
export function isDiffActive(): boolean {
  return active !== null && mode === 'diff';
}

// ---------------------------------------------------------------------------
// Backward-compat shims for views that still talk in {engine, filename, gen}.
// These are derived from the active baseline so the diff views don't need to
// know anything about the pool — they just see "the current baseline session"
// as before.

/** @deprecated prefer getActiveBaseline + getBaselineTraces. */
export interface BaselineSession {
  readonly engine: WasmEngineProxy;
  readonly filename: string;
  readonly gen: number;
}

export function getSession(): BaselineSession | null {
  if (!active) return null;
  return {
    engine: active.trace.engine,
    filename: sessionLabel(active),
    gen,
  };
}

function sessionLabel(b: BaselineDumpRef): string {
  const proc = b.dump.processName ?? `pid ${b.dump.pid}`;
  return `${b.trace.title} · ${proc}`;
}

// ---------------------------------------------------------------------------
// Mutation API.

/**
 * Adds a freshly-loaded baseline trace to the pool. Does NOT auto-select —
 * a trace can have multiple dumps and the loader has no opinion on which
 * one the user wants to compare against. Returns the pool entry so the
 * caller can immediately call setActiveBaseline if it wants to default to
 * the first dump.
 */
export function addBaselineTrace(
  engine: WasmEngineProxy,
  title: string,
  dumps: ReadonlyArray<HeapDump>,
): BaselineTrace {
  const t: BaselineTrace = {
    id: `btrace-${nextTraceId++}`,
    engine,
    title,
    dumps,
  };
  traces = [...traces, t];
  gen = nextGen++;
  m.redraw();
  return t;
}

export function setActiveBaseline(b: BaselineDumpRef | null): void {
  if (
    active !== null &&
    b !== null &&
    active.trace === b.trace &&
    active.dump === b.dump
  ) {
    return;
  }
  active = b;
  // Picking a dump always switches into diff mode — that's the only useful
  // mode after a manual selection. The header still lets the user flip to
  // 'current' or 'baseline' afterwards.
  if (b !== null) mode = 'diff';
  gen = nextGen++;
  m.redraw();
}

/** Clear active baseline selection but keep the trace pool intact. */
export function clearActiveBaseline(): void {
  if (!active) return;
  active = null;
  gen = nextGen++;
  m.redraw();
}

/** Remove a trace from the pool. Disposes its engine. */
export function removeBaselineTrace(traceId: string): void {
  const t = traces.find((x) => x.id === traceId);
  if (!t) return;
  if (active && active.trace === t) active = null;
  traces = traces.filter((x) => x.id !== traceId);
  gen = nextGen++;
  try {
    t.engine[Symbol.dispose]();
  } catch (e) {
    console.error('Error disposing baseline engine:', e);
  }
  m.redraw();
}

/**
 * Tear down everything. Bumps `gen` BEFORE disposing engines so that any
 * view awaiting on a baseline query trips its `gen` guard before the worker
 * dies and pending RPCs hang forever.
 */
export function dispose(): void {
  if (traces.length === 0 && !active) return;
  const old = traces;
  active = null;
  traces = [];
  gen = nextGen++;
  for (const t of old) {
    try {
      t.engine[Symbol.dispose]();
    } catch (e) {
      console.error('Error disposing baseline engine:', e);
    }
  }
  m.redraw();
}

// ---------------------------------------------------------------------------
// Diff filter SQL.

/**
 * SQL fragment that filters `heap_graph_object` (or any join target with
 * matching upid + graph_sample_ts columns) to the active baseline dump.
 * Mirrors `dumpFilterSql` in dumps/state.ts but reads the baseline side.
 * Returns "1=1" when no baseline dump is active.
 */
export function baselineDumpFilterSql(alias: string = 'o'): string {
  if (!active) return '1=1';
  const d = active.dump;
  return `${alias}.upid = ${d.upid} AND ${alias}.graph_sample_ts = ${d.ts}`;
}

// ---------------------------------------------------------------------------
// Debug surface for Playwright tests. Exposed under window.__heapdumpDebug
// so integration tests can introspect baseline state without scraping the
// DOM. Production code never reads this object.

export interface HeapdumpDebugApi {
  hasBaseline(): boolean;
  baselineFilename(): string | null;
  baselineGen(): number;
  mode(): DiffMode;
  baselineQuery(sql: string): Promise<{numRows: number}>;
  poolSize(): number;
}

declare global {
  interface Window {
    __heapdumpDebug?: HeapdumpDebugApi;
  }
}

if (typeof window !== 'undefined') {
  window.__heapdumpDebug = {
    hasBaseline: () => active !== null,
    baselineFilename: () => (active !== null ? sessionLabel(active) : null),
    baselineGen: () => gen,
    mode: () => mode,
    baselineQuery: async (sql: string) => {
      if (!active) throw new Error('No baseline loaded');
      const res = await active.trace.engine.query(sql);
      const rows: unknown[][] = [];
      const it = res.iter({});
      while (it.valid()) {
        rows.push([]);
        it.next();
      }
      return {numRows: rows.length};
    },
    poolSize: () => traces.length,
  };
}
