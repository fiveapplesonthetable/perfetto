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

// Loads a baseline trace into a fresh WasmEngineProxy owned by the plugin.
//
// Replicates the minimal subset of `core/load_trace.ts` needed for heap
// queries:
//   1. Construct WasmEngineProxy (spawns its own Web Worker).
//   2. resetTraceProcessor with default flags.
//   3. Stream the file into the engine via parse() + notifyEof().
//   4. Probe for `heap_graph_object` rows; reject if zero (e.g. user picked
//      a chrome trace by mistake).
//
// Skipped vs. core/load_trace.ts:
//   - extraParsingDescriptors / SQL packages: not needed for heap queries
//     (no plugin registers SQL packages today; the `android.memory.heap_graph.*`
//     modules are bundled in trace_processor itself). Documented limitation.
//   - TraceImpl, getTraceInfo, decideTabs, summary tables, URL nav: all
//     timeline / track / app-state-restore concerns irrelevant to heap SQL.

import {
  LONG,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../../trace_processor/query_result';
import {WasmEngineProxy} from '../../../trace_processor/wasm_engine_proxy';
import type {Raf} from '../../../public/raf';
import type {HeapDump} from '../dumps/state';

/** 32 MiB chunk size, mirrors core/trace_stream.ts:TRACE_SLICE_SIZE. */
const CHUNK_SIZE = 32 * 1024 * 1024;

export interface LoadedBaseline {
  readonly engine: WasmEngineProxy;
  readonly filename: string;
  /**
   * Dumps discovered in the loaded trace, sorted by graph_sample_ts. May
   * have one entry (typical .hprof) or many (multi-process / periodic
   * java_hprof recording). The pool selector renders them all.
   */
  readonly dumps: ReadonlyArray<HeapDump>;
}

export interface LoadProgress {
  /** Bytes streamed into the engine so far. */
  readonly bytesRead: number;
  /** Total bytes in the file. */
  readonly bytesTotal: number;
}

export interface LoadOptions {
  readonly file: File;
  readonly raf: Raf;
  /** Stable id (only used for engine-internal logging). */
  readonly engineId: string;
  /** Called between chunks so the UI can show a progress bar. */
  readonly onProgress?: (p: LoadProgress) => void;
}

/**
 * Errors raised by `loadBaseline` when the input file is unsuitable. Caught
 * and rendered inline by header.ts; the engine has been disposed before the
 * throw so no worker leaks.
 */
export class BaselineLoadError extends Error {
  constructor(
    message: string,
    /** True for "user picked the wrong file" — render gently. */
    readonly userFacing: boolean = true,
  ) {
    super(message);
    this.name = 'BaselineLoadError';
  }
}

/**
 * Constructs a fresh engine, parses the file into it, validates it has heap
 * data, and returns it. On any failure the engine is disposed before the
 * function returns/throws — callers don't need to clean up.
 */
export async function loadBaseline(opts: LoadOptions): Promise<LoadedBaseline> {
  const {file, raf, engineId, onProgress} = opts;

  const engine = new WasmEngineProxy(engineId);
  // Wire redraws so async query results trigger Mithril.
  engine.onResponseReceived = () => raf.scheduleFullRedraw();

  try {
    engine.resetTraceProcessor({
      tokenizeOnly: false,
      cropTrackEvents: false,
      ingestFtraceInRawTable: false,
      analyzeTraceProtoContent: false,
      ftraceDropUntilAllCpusValid: false,
      extraParsingDescriptors: [],
      forceFullSort: false,
    });

    await streamFileIntoEngine(file, engine, onProgress);
    await engine.notifyEof();

    // Probe: does this trace actually have Java heap data?
    const probe = await engine.query(
      'SELECT count(*) AS cnt FROM heap_graph_object LIMIT 1',
    );
    const cnt = probe.firstRow({cnt: NUM}).cnt;
    if (cnt === 0) {
      throw new BaselineLoadError(
        'Selected file has no Java heap data. Diff mode requires a trace ' +
          'with an android.java_hprof or hprof heap dump.',
      );
    }

    const dumps = await enumerateDumps(engine);
    if (dumps.length === 0) {
      // Defensive — heap_graph_object rows existed but the JOIN to process
      // returned nothing. Without a (upid, ts) we cannot filter the diff
      // queries, so the trace is unusable.
      throw new BaselineLoadError(
        'Selected file has heap data but no associated process metadata.',
      );
    }

    return {engine, filename: file.name, dumps};
  } catch (err) {
    // Best-effort dispose; never let an exception leak a worker.
    try {
      engine[Symbol.dispose]();
    } catch {
      // ignore
    }
    if (err instanceof BaselineLoadError) throw err;
    throw new BaselineLoadError(
      `Failed to load baseline trace: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

/**
 * Enumerates the (upid, graph_sample_ts) dumps in a freshly-loaded baseline
 * engine. Mirrors `dumps/loader.ts:loadDumps` for the primary engine but
 * returns the list rather than mutating module state — the pool model wants
 * to add the result via `addBaselineTrace` at the call site.
 */
async function enumerateDumps(
  engine: WasmEngineProxy,
): Promise<ReadonlyArray<HeapDump>> {
  const res = await engine.query(`
    SELECT
      o.upid AS upid,
      o.graph_sample_ts AS ts,
      coalesce(p.cmdline, p.name) AS pname,
      p.pid AS pid
    FROM heap_graph_object o
    JOIN process p USING (upid)
    GROUP BY o.upid, o.graph_sample_ts
    ORDER BY o.graph_sample_ts ASC
  `);
  const out: HeapDump[] = [];
  for (
    const it = res.iter({
      upid: NUM,
      ts: LONG,
      pname: STR_NULL,
      pid: NUM_NULL,
    });
    it.valid();
    it.next()
  ) {
    out.push({
      upid: it.upid,
      ts: it.ts,
      processName: it.pname,
      pid: it.pid ?? 0,
    });
  }
  return out;
}

/**
 * Reads the file in CHUNK_SIZE slices and feeds each into engine.parse().
 * Mirrors `core/load_trace.ts:206-220` behavior with progress callbacks.
 */
async function streamFileIntoEngine(
  file: File,
  engine: WasmEngineProxy,
  onProgress?: (p: LoadProgress) => void,
): Promise<void> {
  const total = file.size;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = file.slice(offset, end);
    const buf = await slice.arrayBuffer();
    await engine.parse(new Uint8Array(buf));
    offset = end;
    onProgress?.({bytesRead: offset, bytesTotal: total});
  }
}
