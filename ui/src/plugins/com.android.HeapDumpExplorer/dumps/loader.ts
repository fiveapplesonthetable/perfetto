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

import {Engine} from '../../../trace_processor/engine';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../../trace_processor/query_result';
import {HeapDump, setDumps} from './state';

/**
 * Enumerate every heap dump in the trace as a (upid, graph_sample_ts) pair
 * and push the result into the dump-state module.
 *
 * A perfetto trace can hold multiple dumps when java_hprof is captured for
 * several processes in the same recording or sampled periodically. The list
 * is sorted by timestamp so the dropdown shows newest-last in chronological
 * order, matching how the user thinks about successive captures.
 */
export async function loadDumps(engine: Engine): Promise<void> {
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
  const dumps: HeapDump[] = [];
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
    dumps.push({
      upid: it.upid,
      ts: it.ts,
      processName: it.pname,
      pid: it.pid ?? 0,
    });
  }
  setDumps(dumps);
}
