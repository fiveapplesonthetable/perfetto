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

// Module-level state for the optional baseline trace + diff mode.
//
// Lifecycle:
//   - State starts empty.
//   - User clicks "Load baseline" → loader.ts builds a WasmEngineProxy,
//     `setLoaded()` is called.
//   - Each diff view captures `session.gen` before its first await; if the
//     value differs after, the view aborts silently.
//   - User clicks ✕ or a new primary trace replaces the current → `dispose()`
//     bumps the generation, terminates the worker, and clears state.
//
// `gen` semantics: incremented on every state transition that invalidates
// in-flight queries (load, dispose). Disposal bumps gen *before* terminating
// the worker so awaiters short-circuit before pending RPCs hang.

import m from 'mithril';
import type {WasmEngineProxy} from '../../../trace_processor/wasm_engine_proxy';

export type DiffMode = 'diff' | 'current' | 'baseline';

export interface BaselineSession {
  readonly engine: WasmEngineProxy;
  readonly filename: string;
  /** Bumped on dispose; views check this before re-rendering. */
  readonly gen: number;
}

let session: BaselineSession | null = null;
let mode: DiffMode = 'diff';
let nextGen = 1;

/** Current session (engine + filename) or null if no baseline is loaded. */
export function getSession(): BaselineSession | null {
  return session;
}

/** Diff/current/baseline mode. Defaults to 'diff' when a baseline is loaded. */
export function getMode(): DiffMode {
  return mode;
}

export function setMode(m: DiffMode): void {
  mode = m;
}

/** Convenience: true when the diff view should render. */
export function isDiffActive(): boolean {
  return session !== null && mode === 'diff';
}

/**
 * Returns the engine for the requested side, or null if not loaded. Used by
 * non-diffable tabs (Objects, Object detail, Flamegraph) to switch which
 * engine they query.
 */
export function getEngineFor(
  side: 'current' | 'baseline',
  currentEngine: WasmEngineProxy,
): WasmEngineProxy {
  if (side === 'baseline' && session) return session.engine;
  return currentEngine;
}

/** Install a freshly-loaded baseline. Replaces any prior session. */
export function setLoaded(engine: WasmEngineProxy, filename: string): void {
  // Dispose any prior baseline first so we never leak a worker.
  dispose();
  session = {engine, filename, gen: nextGen++};
  // A fresh baseline always starts in 'diff' mode — that's the point of
  // loading one. If a previous session left mode='current' or 'baseline',
  // resetting here ensures the user sees the diff immediately. Without
  // this reset the Overview tab would silently render the single-engine
  // layout even though a baseline is loaded.
  mode = 'diff';
  m.redraw();
}

/**
 * Tear down the baseline. Bumps the generation BEFORE terminating the worker
 * so that any view awaiting on a baseline query trips its `gen` guard before
 * the worker dies (and its pending RPCs hang forever).
 */
export function dispose(): void {
  if (!session) return;
  const old = session;
  session = null;
  // Mark gen-mismatch by allocating a new gen (any awaiter holding `old.gen`
  // will see `getSession() === null` or mismatched gen on its next check).
  nextGen++;
  // Now terminate the worker. Pending in-flight queries will reject with
  // worker termination; awaiters guard on gen before touching results.
  try {
    old.engine[Symbol.dispose]();
  } catch (e) {
    console.error('Error disposing baseline engine:', e);
  }
  m.redraw();
}

/** Returns true if `capturedGen` still matches the active session. */
export function isGenStillValid(capturedGen: number): boolean {
  return session !== null && session.gen === capturedGen;
}

// ---------------------------------------------------------------------------
// Debug surface for Playwright tests. Exposed under window.__heapdumpDebug so
// integration tests can introspect baseline state without scraping the DOM.
// Production code never reads this object.

export interface HeapdumpDebugApi {
  hasBaseline(): boolean;
  baselineFilename(): string | null;
  baselineGen(): number;
  mode(): DiffMode;
  /** Direct query on the baseline engine (returns row count). */
  baselineQuery(sql: string): Promise<{numRows: number}>;
}

declare global {
  interface Window {
    __heapdumpDebug?: HeapdumpDebugApi;
  }
}

if (typeof window !== 'undefined') {
  window.__heapdumpDebug = {
    hasBaseline: () => session !== null,
    baselineFilename: () => session?.filename ?? null,
    baselineGen: () => session?.gen ?? 0,
    mode: () => mode,
    baselineQuery: async (sql: string) => {
      if (!session) throw new Error('No baseline loaded');
      const res = await session.engine.query(sql);
      // Return a serializable shape for page.evaluate. We don't know the
      // column types up front; iterate with an empty spec and just count
      // rows.
      const rows: unknown[][] = [];
      const it = res.iter({});
      while (it.valid()) {
        rows.push([]);
        it.next();
      }
      return {numRows: rows.length};
    },
  };
}
