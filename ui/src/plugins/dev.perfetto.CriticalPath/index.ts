// Copyright (C) 2024 The Android Open Source Project
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

import {getThreadInfo, ThreadInfo} from '../../components/sql_utils/thread';
import {addDebugSliceTrack} from '../../components/tracks/debug_tracks';
import {SliceTrack} from '../../components/tracks/slice_track';
import {getColorForSlice} from '../../components/colorizer';
import {Trace} from '../../public/trace';
import {THREAD_STATE_TRACK_KIND} from '../../public/track_kinds';
import {PerfettoPlugin} from '../../public/plugin';
import {TrackNode} from '../../public/workspace';
import {asUtid, Utid} from '../../components/sql_utils/core_types';
import QueryPagePlugin from '../dev.perfetto.QueryPage';
import {showModal} from '../../widgets/modal';
import {
  CRITICAL_PATH_CMD,
  CRITICAL_PATH_LITE_CMD,
} from '../../public/exposed_commands';
import {getTimeSpanOfSelectionOrVisibleWindow} from '../../public/utils';
import {
  LONG,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../trace_processor/query_result';
import {SourceDataset} from '../../trace_processor/dataset';
import {DebugSliceTrackDetailsPanel} from '../../components/tracks/debug_slice_track_details_panel';

// Monotonic counter for table + URI names so re-running the tree
// command on a different thread doesn't collide with prior state.
let treeInvocationCounter = 0;

const criticalPathSliceColumns = {
  ts: 'ts',
  dur: 'dur',
  name: 'name',
};

const criticalPathsliceColumnNames = [
  'id',
  'utid',
  'ts',
  'dur',
  'name',
  'table_name',
];

const sliceLiteColumns = {ts: 'ts', dur: 'dur', name: 'thread_name'};

const sliceLiteColumnNames = [
  'id',
  'utid',
  'ts',
  'dur',
  'thread_name',
  'process_name',
  'table_name',
];

const sliceColumns = {ts: 'ts', dur: 'dur', name: 'name'};

const sliceColumnNames = ['id', 'utid', 'ts', 'dur', 'name', 'table_name'];

function getFirstUtidOfSelectionOrVisibleWindow(trace: Trace): number {
  const selection = trace.selection.selection;
  if (selection.kind === 'area') {
    for (const trackDesc of selection.tracks) {
      if (
        trackDesc?.tags?.kinds?.includes(THREAD_STATE_TRACK_KIND) &&
        trackDesc?.tags?.utid !== undefined
      ) {
        return trackDesc.tags.utid;
      }
    }
  }

  return 0;
}

function showModalErrorAreaSelectionRequired() {
  showModal({
    title: 'Error: range selection required',
    content:
      'This command requires an area selection over a thread state track.',
  });
}

function showModalErrorThreadStateRequired() {
  showModal({
    title: 'Error: thread state selection required',
    content: 'This command requires a thread state slice to be selected.',
  });
}

// If utid is undefined, returns the utid for the selected thread state track,
// if any. If it's defined, looks up the info about that specific utid.
async function getThreadInfoForUtidOrSelection(
  trace: Trace,
  utidArg: unknown,
): Promise<ThreadInfo | undefined> {
  const resolvedUtid =
    typeof utidArg === 'number' ? (utidArg as Utid) : await getUtid(trace);
  if (resolvedUtid === undefined) return undefined;
  return await getThreadInfo(trace.engine, resolvedUtid);
}

/**
 * Get the utid for the current selection. We either grab the utid from the
 * track tags, or we look it up from the dataset.
 *
 * Returns undefined if the selection doesn't really have a utid.
 */
async function getUtid(trace: Trace): Promise<Utid | undefined> {
  // No utid passed, look up the utid from the selected track.
  const selection = trace.selection.selection;
  if (selection.kind !== 'track_event') return undefined;

  const trackUri = selection.trackUri;
  const track = trace.tracks.getTrack(trackUri);
  if (track === undefined) return undefined;

  if (
    track.tags &&
    'utid' in track.tags &&
    typeof track.tags.utid === 'number'
  ) {
    return asUtid(track.tags.utid);
  }

  const dataset = track.renderer.getDataset?.();
  if (dataset === undefined) return undefined;
  if (!dataset.implements({utid: NUM})) return undefined;

  const result = await trace.engine.query(`
    SELECT utid FROM (${dataset.query()}) WHERE id = ${selection.eventId}
  `);
  const firstRow = result.firstRow({utid: NUM});
  return asUtid(firstRow?.utid);
}

export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.CriticalPath';
  static readonly dependencies = [QueryPagePlugin];
  async onTraceLoad(ctx: Trace): Promise<void> {
    // Each command runs both from the command palette (utid looked
    // up from the current selection) and via runCommand(utid) from
    // the thread-state details panel.
    ctx.commands.registerCommand({
      id: CRITICAL_PATH_LITE_CMD,
      name: 'Critical path lite (selected thread state slice)',
      callback: async (utidArg) => {
        const thdInfo = await getThreadInfoForUtidOrSelection(ctx, utidArg);
        if (thdInfo === undefined) {
          return showModalErrorThreadStateRequired();
        }
        await ctx.engine.query(
          `INCLUDE PERFETTO MODULE sched.thread_executing_span;`,
        );
        await addDebugSliceTrack({
          trace: ctx,
          data: {
            sqlSource: `
              SELECT
                cr.id,
                cr.utid,
                cr.ts,
                cr.dur,
                thread.name AS thread_name,
                process.name AS process_name,
                'thread_state' AS table_name
              FROM
                _thread_executing_span_critical_path(
                  ${thdInfo.utid},
                  trace_bounds.start_ts,
                  trace_bounds.end_ts - trace_bounds.start_ts) cr,
                trace_bounds
              JOIN thread USING (utid)
              LEFT JOIN process USING (upid)
            `,
            columns: sliceLiteColumnNames,
          },
          title: `${thdInfo.name}`,
          columns: sliceLiteColumns,
          rawColumns: sliceLiteColumnNames,
        });
      },
    });

    ctx.commands.registerCommand({
      id: 'dev.perfetto.CriticalPathLite_AreaSelection',
      name: 'Critical path lite (over area selection)',
      callback: async () => {
        const trackUtid = getFirstUtidOfSelectionOrVisibleWindow(ctx);
        const window = await getTimeSpanOfSelectionOrVisibleWindow(ctx);
        if (trackUtid === 0) return showModalErrorAreaSelectionRequired();
        await ctx.engine.query(
          `INCLUDE PERFETTO MODULE sched.thread_executing_span;`,
        );
        await addDebugSliceTrack({
          trace: ctx,
          data: {
            sqlSource: `
              SELECT
                cr.id,
                cr.utid,
                cr.ts,
                cr.dur,
                thread.name AS thread_name,
                process.name AS process_name,
                'thread_state' AS table_name
              FROM
                _thread_executing_span_critical_path(
                  ${trackUtid},
                  ${window.start},
                  ${window.end} - ${window.start}) cr
              JOIN thread USING (utid)
              LEFT JOIN process USING (upid)
            `,
            columns: sliceLiteColumnNames,
          },
          title:
            (await getThreadInfo(ctx.engine, trackUtid as Utid)).name ??
            '<thread name>',
          columns: sliceLiteColumns,
          rawColumns: sliceLiteColumnNames,
        });
      },
    });

    const pinCriticalPathTree = async (
      rootUtid: number,
      rootName: string,
      windowTs: bigint,
      windowDur: bigint,
    ): Promise<void> => {
      const invocationId = ++treeInvocationCounter;
      const layeredTable = `__cp_tree_${invocationId}`;
      const baseUri = `dev.perfetto.CriticalPathTree#${invocationId}`;
      const sliceSchema = {id: NUM, ts: LONG, dur: LONG, name: STR};
      let nextTrackId = 0;

      // Materialised layered table shared across all tracks in the
      // tree. Every track's per-slice query is itself materialised
      // by SliceTrack.createMaterialized, so renders on zoom/pan
      // are plain indexed table reads. Deeper tracks are minted on
      // expand.
      await ctx.engine.query(
        `INCLUDE PERFETTO MODULE sched.thread_executing_span;`,
      );
      await ctx.engine.query(`
        CREATE PERFETTO TABLE ${layeredTable} AS
        SELECT
          row_number() OVER (ORDER BY cr.depth, cr.ts) AS id,
          cr.root_id AS root_id,
          cr.id AS node_id,
          cr.parent_id AS parent_node_id,
          cr.depth AS depth,
          cr.ts AS ts,
          ifnull(CAST(cr.dur AS INT), -1) AS dur,
          cr.utid AS utid,
          thread.upid AS upid
        FROM _critical_path_layered_by_intervals!(
               (SELECT ${rootUtid} AS utid,
                       ${windowTs.toString()} AS ts,
                       ${windowDur.toString()} AS dur),
               _wakeup_graph) AS cr
        JOIN thread USING (utid)
      `);
      await ctx.engine.query(`
        CREATE PERFETTO INDEX ${layeredTable}_child_idx
          ON ${layeredTable}(depth, root_id, parent_node_id)
      `);
      const empty = await ctx.engine.query(
        `SELECT COUNT(*) AS n FROM ${layeredTable}`,
      );
      if (empty.firstRow({n: NUM}).n === 0) {
        await ctx.engine.query(`DROP TABLE ${layeredTable}`);
        return showModal({
          title: 'Critical path: no chain found',
          content:
            'No wakeup-graph attribution for this thread over this ' +
            'window. Trace may be missing sched_switch / sched_waking, ' +
            'or this thread never slept with a recorded waker.',
        });
      }

      // Lite output (one row per (root_id, ts) of the deepest active
      // utid) annotated with that utid's depth in its chain.
      // Per-track queries source from this so coverage tiles each
      // anchor's lifetime densely, with each tile classifiable as
      // anchor-running (lite_depth = anchor.depth) or anchor-blocked
      // (lite_depth > anchor.depth) by row presence at that ts.
      const liteTable = `${layeredTable}_lite`;
      await ctx.engine.query(`
        CREATE PERFETTO TABLE ${liteTable} AS
        WITH lite AS (
          SELECT root_id, id AS lite_node_id, ts, dur, utid
          FROM _thread_executing_span_critical_path(
            ${rootUtid},
            ${windowTs.toString()},
            ${windowDur.toString()})
        )
        SELECT lite.root_id, lite.lite_node_id, lite.ts, lite.dur,
               lite.utid, ld.depth AS lite_depth
        FROM lite
        JOIN ${layeredTable} ld
          ON ld.root_id = lite.root_id
          AND ld.utid = lite.utid
          AND ld.ts <= lite.ts
          AND ld.ts + ld.dur >= lite.ts + lite.dur
      `);
      await ctx.engine.query(`
        CREATE PERFETTO INDEX ${liteTable}_root_depth_idx
          ON ${liteTable}(root_id, lite_depth)
      `);

      const placeholderChild = (): TrackNode =>
        new TrackNode({name: '', headless: true});

      // raw_* columns surface the underlying thread_state to the
      // DebugSliceTrackDetailsPanel for jump-to-thread-state.
      const perTrackSchema = {
        ...sliceSchema,
        raw_id: NUM,
        raw_table_name: STR,
        raw_utid: NUM,
      };
      const registerTrackForAnchors = async (
        depth: number,
        groupKey: string,
        anchorRowIds: ReadonlyArray<number>,
      ): Promise<string> => {
        const uri = `${baseUri}.d${depth}.${groupKey}.n${nextTrackId++}`;
        const anchorIdsCsv = anchorRowIds.join(',');
        const childDepth = depth + 1;
        let materializedTableName = '';
        const renderer = await SliceTrack.createMaterialized({
          trace: ctx,
          uri,
          dataset: new SourceDataset({
            schema: perTrackSchema,
            // Per-track slices source from the lite stream restricted
            // to anchor's chains. Each lite tile classifies by row
            // presence at that ts:
            //   lite_depth = anchor.depth → anchor is the deepest
            //     active utid → it's on-CPU/runnable; slice is named
            //     after the anchor itself.
            //   lite_depth > anchor.depth → some depth-(N+1)+ utid is
            //     on-CPU; anchor is blocked. Slice is named after the
            //     depth-(N+1) utid in that chain.
            // Tiles where lite_depth < anchor.depth are filtered: a
            // shallower thread is running, so this track shouldn't
            // claim the time.
            src: `WITH _anc_rows AS (
                    SELECT root_id, node_id AS anc_node_id,
                           utid AS anchor_utid
                    FROM ${layeredTable}
                    WHERE id IN (${anchorIdsCsv})
                  ),
                  _anc AS (
                    SELECT root_id, min(anchor_utid) AS anchor_utid
                    FROM _anc_rows GROUP BY root_id
                  ),
                  _blocker AS (
                    SELECT l.root_id,
                           min(l.utid) AS blocker_utid,
                           min(l.node_id) AS blocker_node_id
                    FROM ${layeredTable} l
                    WHERE l.depth = ${childDepth}
                      AND (l.root_id, l.parent_node_id) IN (
                        SELECT root_id, anc_node_id FROM _anc_rows
                      )
                    GROUP BY l.root_id
                  ),
                  _picked AS (
                    SELECT lite.lite_node_id, lite.ts, lite.dur,
                           CASE WHEN lite.lite_depth = ${depth}
                                THEN _anc.anchor_utid
                                ELSE coalesce(_blocker.blocker_utid,
                                              _anc.anchor_utid)
                           END AS slice_utid,
                           CASE WHEN lite.lite_depth = ${depth}
                                THEN lite.lite_node_id
                                ELSE coalesce(_blocker.blocker_node_id,
                                              lite.lite_node_id)
                           END AS slice_raw_id
                    FROM ${liteTable} lite
                    JOIN _anc USING (root_id)
                    LEFT JOIN _blocker USING (root_id)
                    WHERE lite.lite_depth >= ${depth}
                  )
                  SELECT row_number() OVER (ORDER BY p.ts, p.slice_utid) AS id,
                         p.ts, p.dur,
                         coalesce(thread.name, 'utid ' || p.slice_utid) AS name,
                         p.slice_raw_id AS raw_id,
                         'thread_state' AS raw_table_name,
                         p.slice_utid AS raw_utid
                  FROM _picked p
                  JOIN thread ON thread.utid = p.slice_utid`,
          }),
          colorizer: (row) => getColorForSlice(row.name),
          detailsPanel: (row) =>
            new DebugSliceTrackDetailsPanel(ctx, materializedTableName, row.id),
        });
        materializedTableName = renderer.getDataset()?.src ?? '';
        ctx.tracks.registerTrack({uri, renderer});
        return uri;
      };

      // Resolves the depth-(N+1) children of the given anchors,
      // grouped by upid and then utid for sub-track creation.
      type ChildThread = {
        utid: number;
        tname: string | null;
        rowIds: number[];
        firstTs: bigint;
      };
      type ChildProcess = {
        upid: number;
        pname: string | null;
        threads: Map<number, ChildThread>;
        firstTs: bigint;
      };
      const queryChildren = async (
        parentAnchorRowIds: ReadonlyArray<number>,
      ): Promise<ChildProcess[]> => {
        if (parentAnchorRowIds.length === 0) return [];
        const anchorRes = await ctx.engine.query(`
          SELECT root_id, depth, node_id FROM ${layeredTable}
          WHERE id IN (${parentAnchorRowIds.join(',')})
        `);
        const aIt = anchorRes.iter({
          root_id: NUM,
          depth: NUM,
          node_id: NUM,
        });
        const tuples: string[] = [];
        let nextDepth = -1;
        for (; aIt.valid(); aIt.next()) {
          tuples.push(`(${aIt.root_id}, ${aIt.node_id})`);
          if (nextDepth === -1) nextDepth = aIt.depth + 1;
        }
        if (tuples.length === 0) return [];
        const res = await ctx.engine.query(`
          SELECT l.id AS row_id, l.utid, l.upid, l.ts,
                 thread.name AS tname, process.name AS pname
          FROM ${layeredTable} l
          JOIN thread ON thread.utid = l.utid
          LEFT JOIN process ON process.upid = l.upid
          WHERE l.depth = ${nextDepth}
            AND (l.root_id, l.parent_node_id) IN (
              VALUES ${tuples.join(',')}
            )
          ORDER BY l.ts
        `);
        const it = res.iter({
          row_id: NUM,
          utid: NUM,
          upid: NUM_NULL,
          ts: LONG,
          tname: STR_NULL,
          pname: STR_NULL,
        });
        // -1 stands in for NULL upid (kthreads outside any process).
        const byProcess = new Map<number, ChildProcess>();
        for (; it.valid(); it.next()) {
          const upidKey = it.upid ?? -1;
          let proc = byProcess.get(upidKey);
          if (!proc) {
            proc = {
              upid: upidKey,
              pname: it.pname,
              threads: new Map(),
              firstTs: it.ts,
            };
            byProcess.set(upidKey, proc);
          }
          if (it.ts < proc.firstTs) proc.firstTs = it.ts;
          let th = proc.threads.get(it.utid);
          if (!th) {
            th = {
              utid: it.utid,
              tname: it.tname,
              rowIds: [],
              firstTs: it.ts,
            };
            proc.threads.set(it.utid, th);
          }
          th.rowIds.push(it.row_id);
          if (it.ts < th.firstTs) th.firstTs = it.ts;
        }
        const processes = Array.from(byProcess.values()).sort((a, b) =>
          a.firstTs < b.firstTs ? -1 : a.firstTs > b.firstTs ? 1 : 0,
        );
        for (const p of processes) {
          const ts = Array.from(p.threads.values()).sort((a, b) =>
            a.firstTs < b.firstTs ? -1 : a.firstTs > b.firstTs ? 1 : 0,
          );
          p.threads = new Map(ts.map((t) => [t.utid, t]));
        }
        return processes;
      };

      // Headless folder grouping its child thread tracks. No own
      // slices — only the contained thread tracks render — so the
      // deepest visible level is always a thread track.
      const makeProcessTrack = async (
        depth: number,
        proc: ChildProcess,
      ): Promise<TrackNode> => {
        const label =
          proc.pname ??
          (proc.upid === -1 ? '<no process>' : `<process ${proc.upid}>`);
        const procNode: TrackNode = new TrackNode({
          name: label,
          headless: true,
        });
        const threadNodes = await Promise.all(
          Array.from(proc.threads.values()).map((t) =>
            makeThreadTrack(depth, t),
          ),
        );
        for (const t of threadNodes) procNode.addChildLast(t);
        return procNode;
      };

      // Thread track: a track whose subtree is rooted at T's
      // depth-N anchor rows. Drill expand queries depth-(N+1)
      // children, groups them by upid, and mints sub-tracks.
      const makeThreadTrack = async (
        depth: number,
        t: ChildThread,
      ): Promise<TrackNode> => {
        const label = t.tname ?? `<utid ${t.utid}>`;
        const uri = await registerTrackForAnchors(
          depth,
          `u${t.utid}`,
          t.rowIds,
        );
        let opened = false;
        const threadNode: TrackNode = new TrackNode({
          uri,
          name: label,
          onExpand: () => {
            if (opened) return;
            opened = true;
            (async () => {
              const procs = await queryChildren(t.rowIds);
              const newKids = await Promise.all(
                procs.map((p) => makeProcessTrack(depth + 1, p)),
              );
              for (const c of [...threadNode.children]) {
                threadNode.removeChild(c);
              }
              for (const k of newKids) threadNode.addChildLast(k);
            })();
          },
        });
        threadNode.addChildLast(placeholderChild());
        return threadNode;
      };

      const rootRes = await ctx.engine.query(`
        SELECT id FROM ${layeredTable}
        WHERE depth = 0 AND utid = ${rootUtid}
        ORDER BY ts
      `);
      const rootAnchors: number[] = [];
      const itRoot = rootRes.iter({id: NUM});
      for (; itRoot.valid(); itRoot.next()) rootAnchors.push(itRoot.id);
      if (rootAnchors.length === 0) {
        await ctx.engine.query(`DROP TABLE ${layeredTable}`);
        return showModal({
          title: 'Critical path: root has no on-CPU contribution',
          content:
            'The root thread does not appear at depth 0 in the layered ' +
            'output for this window — the chain may be entirely from ' +
            'wakers with no self-runs in this range.',
        });
      }
      const rootUri = await registerTrackForAnchors(
        0,
        `u${rootUtid}`,
        rootAnchors,
      );
      let rootOpened = false;
      const rootNode: TrackNode = new TrackNode({
        uri: rootUri,
        name: rootName,
        onExpand: () => {
          if (rootOpened) return;
          rootOpened = true;
          (async () => {
            const procs = await queryChildren(rootAnchors);
            const newKids = await Promise.all(
              procs.map((p) => makeProcessTrack(1, p)),
            );
            for (const c of [...rootNode.children]) rootNode.removeChild(c);
            for (const k of newKids) rootNode.addChildLast(k);
          })();
        },
      });
      rootNode.addChildLast(placeholderChild());

      const groupNode = new TrackNode({
        name: `Critical path: ${rootName}`,
        removable: true,
        headless: true,
      });
      groupNode.addChildLast(rootNode);
      ctx.currentWorkspace.pinnedTracksNode.addChildLast(groupNode);
    };

    ctx.commands.registerCommand({
      id: 'dev.perfetto.CriticalPathTree',
      name: 'Critical path (selected thread state slice)',
      callback: async (utidArg) => {
        const thdInfo = await getThreadInfoForUtidOrSelection(ctx, utidArg);
        if (thdInfo === undefined) return showModalErrorThreadStateRequired();
        const tb = await ctx.engine.query(
          `SELECT start_ts AS s, end_ts AS e FROM trace_bounds`,
        );
        const tbRow = tb.firstRow({s: LONG, e: LONG});
        await pinCriticalPathTree(
          thdInfo.utid,
          thdInfo.name ?? `utid ${thdInfo.utid}`,
          tbRow.s,
          tbRow.e - tbRow.s,
        );
      },
    });

    ctx.commands.registerCommand({
      id: 'dev.perfetto.CriticalPathTree_AreaSelection',
      name: 'Critical path (over area selection)',
      callback: async () => {
        const trackUtid = getFirstUtidOfSelectionOrVisibleWindow(ctx);
        const window = await getTimeSpanOfSelectionOrVisibleWindow(ctx);
        if (trackUtid === 0) return showModalErrorAreaSelectionRequired();
        const thdInfo = await getThreadInfo(ctx.engine, trackUtid as Utid);
        await pinCriticalPathTree(
          trackUtid,
          thdInfo.name ?? `utid ${trackUtid}`,
          window.start,
          window.end - window.start,
        );
      },
    });

    ctx.commands.registerCommand({
      id: CRITICAL_PATH_CMD,
      name: 'Critical path stacks (selected thread state slice)',
      callback: async (utidArg) => {
        const thdInfo = await getThreadInfoForUtidOrSelection(ctx, utidArg);
        if (thdInfo === undefined) {
          return showModalErrorThreadStateRequired();
        }
        ctx.engine
          .query(
            `INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;`,
          )
          .then(() =>
            addDebugSliceTrack({
              trace: ctx,
              data: {
                sqlSource: `
                SELECT cr.id, cr.utid, cr.ts, cr.dur, cr.name, cr.table_name
                  FROM
                    _thread_executing_span_critical_path_stack(
                      ${thdInfo.utid},
                      trace_bounds.start_ts,
                      trace_bounds.end_ts - trace_bounds.start_ts) cr,
                    trace_bounds WHERE name IS NOT NULL
              `,
                columns: sliceColumnNames,
              },
              title: `${thdInfo.name}`,
              columns: sliceColumns,
              rawColumns: sliceColumnNames,
            }),
          );
      },
    });

    ctx.commands.registerCommand({
      id: 'dev.perfetto.CriticalPath_AreaSelection',
      name: 'Critical path stacks (over area selection)',
      callback: async () => {
        const trackUtid = getFirstUtidOfSelectionOrVisibleWindow(ctx);
        const window = await getTimeSpanOfSelectionOrVisibleWindow(ctx);
        if (trackUtid === 0) {
          return showModalErrorAreaSelectionRequired();
        }
        await ctx.engine.query(
          `INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;`,
        );
        await addDebugSliceTrack({
          trace: ctx,
          data: {
            sqlSource: `
                SELECT cr.id, cr.utid, cr.ts, cr.dur, cr.name, cr.table_name
                FROM
                _critical_path_stack(
                  ${trackUtid},
                  ${window.start},
                  ${window.end} - ${window.start}, 1, 1, 1, 1) cr
                WHERE name IS NOT NULL
                `,
            columns: criticalPathsliceColumnNames,
          },
          title:
            (await getThreadInfo(ctx.engine, trackUtid as Utid)).name ??
            '<thread name>',
          columns: criticalPathSliceColumns,
          rawColumns: criticalPathsliceColumnNames,
        });
      },
    });

    ctx.commands.registerCommand({
      id: 'dev.perfetto.CriticalPathPprof_AreaSelection',
      name: 'Critical path pprof (over area selection)',
      callback: async () => {
        const trackUtid = getFirstUtidOfSelectionOrVisibleWindow(ctx);
        const window = await getTimeSpanOfSelectionOrVisibleWindow(ctx);
        if (trackUtid === 0) {
          return showModalErrorAreaSelectionRequired();
        }
        ctx.plugins.getPlugin(QueryPagePlugin).addQueryResultsTab({
          query: `
              INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;
              SELECT *
                FROM
                  _thread_executing_span_critical_path_graph(
                  "criical_path",
                    ${trackUtid},
                    ${window.start},
                    ${window.end} - ${window.start}) cr`,
          title: 'Critical path',
        });
      },
    });
  }
}
