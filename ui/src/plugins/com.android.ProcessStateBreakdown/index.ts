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

// A standalone breakdown of process proc_state over time, built from the raw
// AndroidProcessStateChangedEvent track events (independent of the snapshot
// ProcessState explorer plugin). It reconstructs a durative proc_state interval
// per (uid, pid) — process_state_intervals — and exposes two track groups:
//   1. "Process states (concurrent)": one concurrency counter per proc_state
//      (how many processes are in that state at any instant, via the
//      intervals.overlap stdlib), each drilling into a slice track of the
//      contributing process intervals.
//   2. "Process states by package": one slice track per package (capped to the
//      most-active MAX_PACKAGES), showing that package's proc_state intervals.
//
// Tracks are built directly (CounterTrack + SliceTrack) rather than via the
// generic BreakdownTracks helper, which registers a track per pivot *value*
// (state x process = tens of thousands on a long trace). Counters are lazy and
// the whole build is kicked off without blocking trace load.

import {sqliteString} from '../../base/string_utils';
import {CounterTrack} from '../../components/tracks/counter_track';
import {SliceTrack} from '../../components/tracks/slice_track';
import {materialColorScheme} from '../../components/colorizer';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';

const PLUGIN_ID = 'com.android.ProcessStateBreakdown';
const TABLE = 'process_state_intervals';

// The by-package group is one slice track per (package, uid); cap it
// (most-active first) so a trace with thousands of uids can't register thousands
// of tracks.
const MAX_PACKAGES = 100;

const SETUP_SQL: ReadonlyArray<string> = [
  // The raw point events. Keyed by the presence of the cur_proc_state arg rather
  // than the slice name, so it works whether or not the producer named the
  // slices. cur_proc_state is a ProcessStateEnum field, so extract_arg already
  // returns the resolved enum name (e.g. "PROCESS_STATE_TOP").
  `CREATE PERFETTO TABLE _psi_changed AS
   SELECT s.ts,
          extract_arg(s.arg_set_id, 'process_state_changed_event.uid') AS uid,
          extract_arg(s.arg_set_id, 'process_state_changed_event.pid') AS pid,
          extract_arg(s.arg_set_id, 'process_state_changed_event.cur_proc_state')
            AS state_name
   FROM slice s
   WHERE s.arg_set_id IN (
     SELECT arg_set_id FROM args
     WHERE key = 'process_state_changed_event.cur_proc_state')`,

  // Turn the point events into durative state intervals per (uid, pid): keep the
  // rows where the state changes, then span each to the next change (the last
  // extends to the trace end). Names are a best-effort label from package_list /
  // the process table, falling back to the uid.
  `CREATE PERFETTO TABLE ${TABLE} AS
   WITH lagged AS (
     SELECT ts, uid, pid, state_name,
            LAG(state_name) OVER w AS prev_state
     FROM _psi_changed
     WINDOW w AS (PARTITION BY uid, pid ORDER BY ts)
   ),
   trans AS (
     SELECT ts, uid, pid, state_name FROM lagged
     WHERE prev_state IS NULL OR state_name IS NOT prev_state
   ),
   spans AS (
     SELECT ts, uid, pid, state_name,
            LEAD(ts) OVER (PARTITION BY uid, pid ORDER BY ts) AS next_ts
     FROM trans
   )
   SELECT
     sp.ts,
     COALESCE(sp.next_ts, (SELECT end_ts FROM trace_bounds)) - sp.ts AS dur,
     sp.uid, sp.pid,
     REPLACE(sp.state_name, 'PROCESS_STATE_', '') AS state,
     COALESCE(pk.package_name, pr.name, 'uid ' || sp.uid) AS package_name,
     COALESCE(pk.package_name, pr.name, 'uid ' || sp.uid) || ' (' || sp.uid || ')'
       AS name
   FROM spans sp
   LEFT JOIN (
     SELECT uid, MIN(package_name) AS package_name FROM package_list GROUP BY uid
   ) pk ON pk.uid = (sp.uid % 100000)
   LEFT JOIN (
     SELECT pid, name FROM process WHERE name IS NOT NULL GROUP BY pid
   ) pr ON pr.pid = sp.pid
   WHERE COALESCE(sp.next_ts, (SELECT end_ts FROM trace_bounds)) - sp.ts > 0`,

  // Index the two filter dimensions (state for the counters, uid for the
  // per-(package,uid) tracks) so each track's mipmap is a fast lookup rather than
  // a scan of every interval.
  `CREATE PERFETTO INDEX _psi_by_state ON ${TABLE}(state)`,
  `CREATE PERFETTO INDEX _psi_by_uid ON ${TABLE}(uid)`,

  // For the per-state concurrency counters.
  `INCLUDE PERFETTO MODULE intervals.overlap`,
];

// Builds process_state_intervals; returns the row count (0 => no
// process_state_changed events in this trace, skip the tracks).
async function buildIntervals(trace: Trace): Promise<number> {
  try {
    for (const sql of SETUP_SQL) {
      await trace.engine.query(sql);
    }
  } catch {
    return 0;
  }
  const res = await trace.engine.query(`SELECT count(*) AS n FROM ${TABLE}`);
  return res.firstRow({n: NUM}).n;
}

// A slice track over the intervals matching a WHERE clause, each slice named by
// `nameExpr` and coloured by it. The dataset deliberately omits `depth`: with a
// `dur` but no `depth`, SliceTrack auto-lays-out the slices (internal_layout), so
// intervals from different processes in the same track stack into rows instead of
// overlaying each other — the way debug tracks behave.
function intervalSliceTrack(
  trace: Trace,
  uri: string,
  where: string,
  nameExpr: string,
) {
  return SliceTrack.create({
    trace,
    uri,
    dataset: new SourceDataset({
      schema: {id: NUM, ts: LONG, dur: LONG, name: STR},
      src: `SELECT ROW_NUMBER() OVER (ORDER BY ts) AS id, ts, dur,
                   ${nameExpr} AS name
            FROM ${TABLE} WHERE ${where}`,
    }),
    colorizer: (row) => materialColorScheme(row.name),
  });
}

async function createTracks(trace: Trace): Promise<TrackNode[]> {
  // Group 1: concurrency by proc_state -> contributing process slices.
  const stateGroup = new TrackNode({
    name: 'Process states (concurrent)',
    isSummary: true,
  });
  const states = await trace.engine.query(
    `SELECT DISTINCT state FROM ${TABLE} ORDER BY state`,
  );
  for (const it = states.iter({state: STR}); it.valid(); it.next()) {
    const state = it.state;
    const lit = sqliteString(state);
    const base = `/process_state_intervals/state/${state}`;

    const countUri = `${base}/count`;
    trace.tracks.registerTrack({
      uri: countUri,
      // Lazy: the overlap count is computed when the counter is scrolled into
      // view, not for every state at load.
      renderer: CounterTrack.create({
        trace,
        uri: countUri,
        sqlSource: `SELECT ts, value FROM intervals_overlap_count!(
          (SELECT ts, dur FROM ${TABLE} WHERE state = ${lit}), ts, dur)`,
      }),
    });
    const stateNode = new TrackNode({
      uri: countUri,
      name: state,
      isSummary: true,
    });
    stateGroup.addChildLast(stateNode);

    const sliceUri = `${base}/slices`;
    trace.tracks.registerTrack({
      uri: sliceUri,
      renderer: intervalSliceTrack(trace, sliceUri, `state = ${lit}`, 'name'),
    });
    stateNode.addChildLast(
      new TrackNode({uri: sliceUri, name: `${state} processes`}),
    );
  }

  // Group 2: one track per (package, uid). Within a track, the proc_state
  // intervals of every process in that uid are auto-laid-out by depth (see
  // intervalSliceTrack), so multiple processes stack into rows instead of
  // overlaying. Slices are named/coloured by state. Capped to the most-active.
  const pkgGroup = new TrackNode({
    name: 'Process states by package',
    isSummary: true,
  });
  const uids = await trace.engine.query(`
    SELECT uid, MAX(name) AS label FROM ${TABLE}
    GROUP BY uid ORDER BY sum(dur) DESC LIMIT ${MAX_PACKAGES}`);
  for (const it = uids.iter({uid: NUM, label: STR}); it.valid(); it.next()) {
    const uri = `/process_state_intervals/uid/${it.uid}`;
    trace.tracks.registerTrack({
      uri,
      renderer: intervalSliceTrack(trace, uri, `uid = ${it.uid}`, 'state'),
    });
    pkgGroup.addChildLast(new TrackNode({uri, name: it.label}));
  }

  return [stateGroup, pkgGroup];
}

// Standalone proc_state interval breakdown. Reads the raw process_state_changed
// track events, so it activates on any trace that carries them.
export default class implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;

  async onTraceLoad(ctx: Trace): Promise<void> {
    // Reconstructing an interval per (uid,pid) from every process_state_changed
    // event is heavy on long traces; build it in the background so it never
    // blocks trace load. The tracks pop in when ready.
    void this.build(ctx).catch(() => {});
  }

  private async build(ctx: Trace): Promise<void> {
    if ((await buildIntervals(ctx)) === 0) return;
    let sortOrder = -49;
    for (const node of await createTracks(ctx)) {
      node.sortOrder = sortOrder++;
      ctx.defaultWorkspace.addChildInOrder(node);
    }
  }
}
