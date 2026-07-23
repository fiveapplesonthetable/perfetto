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

import './styles.scss';
import {QuerySlot, SerialTaskQueue} from '../../base/query_slot';
import {LockOwnerDetailsPanel} from './lock_owner_details_panel';
import {LOCK_CONTENTION_SQL} from './lock_contention_sql';
import type {Selection} from '../../public/selection';
import {Time} from '../../base/time';
import {LONG, NUM} from '../../trace_processor/query_result';
import type {ArrowConnection} from '../../components/related_events/arrow_visualiser';
import {
  getTrackUriForTrackId,
  TrackPinningManager,
} from '../../components/related_events/utils';
import {addDebugSliceTrack} from '../../components/tracks/debug_tracks';
import {
  BreakdownTracks,
  BreakdownTrackAggType,
} from '../../components/tracks/breakdown_tracks';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {RelatedEventsOverlay} from '../../components/related_events/related_events_overlay';

export default class AndroidLockContentionPlugin implements PerfettoPlugin {
  static readonly id = 'com.android.AndroidLockContention';
  static readonly description =
    'Visualise lock contention events in the trace. You can navigate between contention events using ] and [';

  private readonly connectionsTaskQueue = new SerialTaskQueue();
  private readonly connectionsSlot = new QuerySlot<ArrowConnection[]>(
    this.connectionsTaskQueue,
  );
  public highlightedTargetIds = new Set<number>();
  public pinningManager!: TrackPinningManager;
  public currentBlockedSlice?: {id: number; trackUri?: string};

  private async contextualJump(trace: Trace) {
    const selection = trace.selection.selection;
    if (selection.kind !== 'track_event') return;
    // A blocking-contention slice carries the android_monitor_contention id.
    // Jump to the thread it is blocking (the victim).
    const q = await trace.engine.query(`
      SELECT tt.id AS track_id
      FROM android_monitor_contention c
      JOIN thread_track tt ON tt.utid = c.blocked_utid
      WHERE c.id = ${selection.eventId}
      LIMIT 1
    `);
    if (q.numRows() === 0) return;
    const uri = getTrackUriForTrackId(
      trace,
      q.firstRow({track_id: NUM}).track_id,
    );
    if (uri === undefined) return;
    this.navigation.push(selection, selection.eventId, selection.trackUri);
    trace.selection.selectTrack(uri, {
      scrollToSelection: true,
      switchToCurrentSelectionTab: false,
    });
  }

  public readonly navigation = new LockContentionNavigation();

  public selectAndNavigate(
    trace: Trace,
    eventId: number,
    trackUri?: string,
    isSqlEvent = false,
  ) {
    const selection = trace.selection.selection;
    if (selection !== undefined) {
      this.navigation.push(selection, eventId, trackUri);
    }

    if (isSqlEvent) {
      trace.selection.selectSqlEvent('slice', eventId, {
        scrollToSelection: true,
        switchToCurrentSelectionTab: false,
      });
    } else if (trackUri) {
      trace.selection.selectTrackEvent(trackUri, eventId, {
        scrollToSelection: true,
        switchToCurrentSelectionTab: false,
      });
    }
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    this.pinningManager = new TrackPinningManager(trace);
    await trace.engine.query(LOCK_CONTENTION_SQL);

    trace.tracks.registerOverlay(
      new RelatedEventsOverlay(trace, () => this.getConnections(trace)),
    );

    trace.commands.registerCommand({
      id: 'com.android.AndroidLockContention:ToggleView',
      name: 'Android Lock Contention: Toggle View',
      defaultHotkey: ']',
      callback: () => {
        this.contextualJump(trace);
      },
    });

    trace.commands.registerCommand({
      id: 'com.android.AndroidLockContention:NavigateBackward',
      name: 'Android Lock Contention: Navigate Backward',
      defaultHotkey: '[',
      callback: async () => {
        await this.navigation.goBack(trace, this);
      },
    });

    trace.commands.registerCommand({
      id: 'com.android.visualiseHeldLocks',
      name: 'Lock Contention: Visualise held locks',
      callback: async () => {
        await addDebugSliceTrack({
          trace: trace,
          data: {
            sqlSource: `
                    WITH lock_held_slices AS (
                    SELECT ts, dur, lock_name, utid
                    FROM interval_merge_overlapping_partitioned!((
                        SELECT ts, dur, name AS lock_name, utid
                        FROM thread_slice
                        WHERE dur > 0 AND thread_slice.name GLOB '*_lock_held'
                    ), (lock_name, utid))
                    )
                    SELECT
                    row_number() OVER () AS id,
                    name AS thread_name,
                    lock_name,
                    utid,
                    ts,
                    MIN(LEAD(ts) OVER(PARTITION BY lock_name ORDER BY ts), ts + dur) - ts AS dur
                    FROM lock_held_slices
                    JOIN thread USING (utid)
                `,
          },
          title: 'Held Lock',
          columns: {
            name: 'thread_name',
          },
          pivotOn: 'lock_name',
        });
      },
    });

    await this.registerContentionBreakdownTracks(trace);
  }

  // For each thread that blocks others on a monitor, nests a "Blocking
  // contention" track under that thread's own slice track. The counter is the
  // number of threads it is blocking at once (interval intersection, like the
  // rest of BreakdownTracks), which drills down into a counter per blocked
  // thread and finally the contention slices. Collapsed by default (TrackNode
  // starts collapsed), so it stays out of the way until the thread is expanded.
  private async registerContentionBreakdownTracks(trace: Trace): Promise<void> {
    await trace.engine.query(
      'INCLUDE PERFETTO MODULE android.monitor_contention;',
    );
    const threads = await trace.engine.query(`
      SELECT c.blocking_utid AS utid, tt.id AS track_id
      FROM (
        SELECT DISTINCT blocking_utid FROM android_monitor_contention
        WHERE blocking_utid IS NOT NULL
      ) c
      JOIN thread_track tt ON tt.utid = c.blocking_utid
    `);
    const it = threads.iter({utid: NUM, track_id: NUM});
    for (; it.valid(); it.next()) {
      const utid = it.utid;
      const trackId = it.track_id;

      const threadTrack = trace.tracks.findTrack((t) =>
        t.tags?.trackIds?.includes(trackId),
      );
      if (!threadTrack) continue;
      const threadNode = trace.currentWorkspace.getTrackByUri(threadTrack.uri);
      if (!threadNode) continue;

      // One table per blocking thread: the counter's overlap count must be
      // computed over this thread's contentions only, so each BreakdownTracks
      // instance intersects just this subset.
      const tableName = `_lock_contention_blocking_${utid}`;
      await trace.engine.query(`
        CREATE PERFETTO TABLE ${tableName} AS
        SELECT id, ts, dur,
          blocked_thread_name || ' [' || blocked_thread_tid || ']' AS blocked
        FROM android_monitor_contention
        WHERE blocking_utid = ${utid} AND dur > 0
      `);

      const breakdown = new BreakdownTracks({
        trace,
        trackTitle: 'Blocking contention',
        description:
          'Threads this thread is blocking on a monitor. The counter is how ' +
          'many it blocks at once; expand for a slice track per blocked thread.',
        aggregationType: BreakdownTrackAggType.COUNT,
        aggregation: {
          tableName,
          columns: [],
          tsCol: 'ts',
          durCol: 'dur',
        },
        slice: {
          tableName,
          columns: ['blocked'],
          tsCol: 'ts',
          durCol: 'dur',
        },
        sliceIdColumn: 'id',
        detailsPanel: (t, row) =>
          new LockOwnerDetailsPanel(t, row.id, this),
      });

      const rootNode = await breakdown.createTracks();
      rootNode.name = 'Blocking contention';
      threadNode.addChildInOrder(rootNode);
    }
  }

  private getConnections(trace: Trace): ArrowConnection[] {
    const selection = trace.selection.selection;
    if (selection.kind !== 'track_event') return [];
    const result = this.connectionsSlot.use({
      key: {eventId: selection.eventId, trackUri: selection.trackUri},
      queryFn: () => this.fetchConnections(trace, selection),
    });
    return result.data ?? [];
  }

  private async fetchConnections(
    trace: Trace,
    selection: Selection & {kind: 'track_event'},
  ): Promise<ArrowConnection[]> {
    // Draw an arrow from the selected blocking-contention slice to the thread
    // it is blocking, at the contention's midpoint.
    const q = await trace.engine.query(`
      SELECT c.ts, c.dur, tt.id AS blocked_track_id
      FROM android_monitor_contention c
      JOIN thread_track tt ON tt.utid = c.blocked_utid
      WHERE c.id = ${selection.eventId}
      LIMIT 1
    `);
    if (q.numRows() === 0) return [];
    const row = q.firstRow({ts: LONG, dur: LONG, blocked_track_id: NUM});
    const blockedUri = getTrackUriForTrackId(trace, row.blocked_track_id);
    if (blockedUri === undefined) return [];
    const mid = Time.fromRaw(row.ts + row.dur / 2n);
    return [
      {
        start: {trackUri: selection.trackUri, ts: mid, depth: 0},
        end: {trackUri: blockedUri, ts: mid, depth: 0},
      },
    ];
  }
}

function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'track_event' && b.kind === 'track_event') {
    return a.eventId === b.eventId && a.trackUri === b.trackUri;
  }
  if (a.kind === 'track' && b.kind === 'track') {
    return a.trackUri === b.trackUri;
  }
  return false;
}

class LockContentionNavigation {
  private stack: {
    source: Selection;
    targetEventId: number;
    targetTrackUri?: string;
  }[] = [];

  push(source: Selection, targetEventId: number, targetTrackUri?: string) {
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined && selectionsEqual(top.source, source)) {
      return;
    }
    this.stack.push({source, targetEventId, targetTrackUri});
  }

  async goBack(trace: Trace, plugin: AndroidLockContentionPlugin) {
    const currentSelection = trace.selection.selection;

    const top = this.stack[this.stack.length - 1];
    if (
      top !== undefined &&
      currentSelection.kind === 'track_event' &&
      currentSelection.eventId === top.targetEventId &&
      (top.targetTrackUri === undefined ||
        currentSelection.trackUri === top.targetTrackUri ||
        currentSelection.trackUri === 'unknown')
    ) {
      this.stack.pop();
      this.restore(trace, top.source);
      return;
    }

    // Fallback: if we are on the owner track, try to go back to the original slice
    if (
      currentSelection.kind === 'track_event' &&
      currentSelection.trackUri.startsWith(
        'com.android.AndroidLockContention#OwnerEvents',
      )
    ) {
      const blockedSlice = plugin.currentBlockedSlice;
      if (blockedSlice && blockedSlice.trackUri) {
        trace.selection.selectTrackEvent(
          blockedSlice.trackUri,
          blockedSlice.id,
          {
            scrollToSelection: true,
            switchToCurrentSelectionTab: false,
          },
        );
        return;
      }
    }

    if (this.stack.length > 0) {
      this.stack = [];
    }
  }

  private restore(trace: Trace, selection: Selection) {
    if (selection.kind === 'track_event') {
      if (selection.trackUri === 'unknown' || selection.trackUri === '') {
        trace.selection.selectSqlEvent('slice', selection.eventId, {
          scrollToSelection: true,
          switchToCurrentSelectionTab: false,
        });
      } else {
        trace.selection.selectTrackEvent(
          selection.trackUri,
          selection.eventId,
          {
            scrollToSelection: true,
            switchToCurrentSelectionTab: false,
          },
        );
      }
    } else if (selection.kind === 'track') {
      trace.selection.selectTrack(selection.trackUri, {
        scrollToSelection: true,
        switchToCurrentSelectionTab: false,
      });
    }
  }

  has(selection: Selection) {
    return this.stack.some((s) => selectionsEqual(s.source, selection));
  }
}
