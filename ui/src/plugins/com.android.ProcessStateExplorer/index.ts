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

import m from 'mithril';

import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {Time} from '../../base/time';
import {TrackNode} from '../../public/workspace';
import {SliceTrack} from '../../components/tracks/slice_track';
import {SourceDataset} from '../../trace_processor/dataset';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../trace_processor/query_result';
import {Button} from '../../widgets/button';
import {Chip} from '../../widgets/chip';
import {Grid, GridCell, GridHeaderCell} from '../../widgets/grid';
import {Tabs} from '../../widgets/tabs';
import type {TabsTab} from '../../widgets/tabs';
import {
  MultiSelectDiff,
  MultiSelectOption,
  PopupMultiSelect,
} from '../../widgets/multiselect';
import {PopupPosition} from '../../widgets/popup';
import {Icons} from '../../base/semantic_icons';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {ForceGraph} from '../../components/widgets/force_graph';
import type {ForceGraphNode} from '../../components/widgets/force_graph';

interface SnapshotMeta {
  id: number;
  ts: number;
  oomAdjReason: number;
  topPid: number | null;
  isFull: boolean;
}

interface ProcessRow {
  pid: number;
  uid: number;
  userId: number;
  processName: string | null;
  packageName: string | null;
  curAdj: number | null;
  setAdj: number | null;
  maxAdj: number | null;
  curProcState: number | null;
  curCapability: number | null;
  curSchedGroup: number | null;
  hasForegroundActivities: boolean;
  hasTopUi: boolean;
  hasOverlayUi: boolean;
  hasVisibleActivities: boolean;
  hasStartedServices: boolean;
  persistent: boolean;
  isolated: boolean;
  hasActiveInstrumentation: boolean;
  lruIndex: number;
}

interface ServiceEdge {
  kind: 'service';
  clientPid: number;
  ownerPid: number;
  shortName: string | null;
  flagAutoCreate: boolean;
  flagForegroundService: boolean;
  flagNotForeground: boolean;
  flagAboveClient: boolean;
  flagAllowOomManagement: boolean;
  flagWaivePriority: boolean;
  flagImportant: boolean;
  flagAdjustWithActivity: boolean;
  flagIncludeCapabilities: boolean;
}

interface ProviderEdge {
  kind: 'provider';
  clientPid: number;
  ownerPid: number;
  authority: string | null;
  packageName: string | null;
  className: string | null;
  stableCount: number;
  unstableCount: number;
  dead: boolean;
  waiting: boolean;
}

type AnchorEdge = ServiceEdge | ProviderEdge;

type WhyAliveReason =
  | {kind: 'intrinsic'; flags: string[]}
  | {kind: 'cached'; curAdj: number | null}
  | {kind: 'data-gap'; curAdj: number}
  | {kind: 'persistent-service'; curAdj: number}
  | {kind: 'persistent-proc'; curAdj: number}
  | {kind: 'cycle'}
  | {
      kind: 'inherited';
      parentPid: number;
      parentRow: ProcessRow;
      edge: AnchorEdge;
      upstream: WhyAliveReason;
    };

const TAB_TABLE = 'table';
const TAB_GRAPH = 'graph';
const TAB_BINDINGS = 'bindings';
type TabKey = typeof TAB_TABLE | typeof TAB_GRAPH | typeof TAB_BINDINGS;

const PAGE_ROUTE = '/process_state';
const PAGE_HASH = '#!' + PAGE_ROUTE;
const PAGE_TITLE = 'Process state explorer';

// Process State Explorer — perfetto-replay viewer for the
// android.process_state data source. Three tabs (Table / Binding
// Graph / Bindings) share a single process selection driven by a
// PopupMultiSelect rendered in the Tabs widget's rightContent.
// Both service bindings AND content-provider bindings count as
// anchors that keep a process alive — the chain reasoner walks
// them indiscriminately.
export default class implements PerfettoPlugin {
  static readonly id = 'com.android.ProcessStateExplorer';
  static readonly description =
    'Explorer for ProcessStateController state — like winscope for OomAdjuster.';

  private snapshots: SnapshotMeta[] = [];
  private currentIdx = 0;
  private currentRows: ProcessRow[] = [];
  private currentEdges: AnchorEdge[] = [];
  private procByPid: Map<number, ProcessRow> = new Map();

  private selectedPids = new Set<number>();
  private activeTab: TabKey = TAB_TABLE;
  private loadSeq = 0;

  private graphWidth = 1200;
  private graphHeight = 700;

  async onTraceLoad(trace: Trace): Promise<void> {
    let count = 0;
    try {
      const r = await trace.engine.query(
        `select count(1) as cnt from android_process_state_snapshot`,
      );
      count = r.firstRow({cnt: NUM}).cnt;
    } catch (_e) {
      return;
    }
    if (count === 0) return;

    const snapsRes = await trace.engine.query(
      `select id, ts, oom_adj_reason as r,
              top_pid as top, is_full as full
       from android_process_state_snapshot
       order by ts asc`,
    );
    const it = snapsRes.iter({
      id: NUM,
      ts: NUM,
      r: NUM,
      top: NUM_NULL,
      full: NUM,
    });
    for (; it.valid(); it.next()) {
      this.snapshots.push({
        id: it.id,
        ts: it.ts,
        oomAdjReason: it.r,
        topPid: it.top ?? null,
        isFull: it.full === 1,
      });
    }
    if (this.snapshots.length === 0) return;

    await this.loadSnapshot(trace, 0);

    trace.pages.registerPage({
      route: PAGE_ROUTE,
      render: () => this.renderPage(trace),
    });

    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: PAGE_TITLE,
      href: PAGE_HASH,
      icon: 'memory',
      sortOrder: 10,
    });

    trace.commands.registerCommand({
      id: 'com.android.ProcessStateExplorer#open',
      name: `Open ${PAGE_TITLE}`,
      callback: () => {
        window.location.hash = PAGE_HASH;
      },
    });

    const trackUri = 'com.android.ProcessStateExplorer#snapshots';
    trace.tracks.registerTrack({
      uri: trackUri,
      renderer: await SliceTrack.createMaterialized({
        trace,
        uri: trackUri,
        dataset: new SourceDataset({
          schema: {
            ts: LONG,
            dur: LONG_NULL,
            name: STR,
          },
          src: `
            SELECT
              ts,
              0 AS dur,
              CASE WHEN is_full = 1 THEN 'anchor: ' ELSE 'delta: ' END
                || CASE oom_adj_reason
                  WHEN 0 THEN 'NONE'
                  WHEN 1 THEN 'ACTIVITY'
                  WHEN 2 THEN 'FINISH_RECEIVER'
                  WHEN 3 THEN 'START_RECEIVER'
                  WHEN 4 THEN 'BIND_SERVICE'
                  WHEN 5 THEN 'UNBIND_SERVICE'
                  WHEN 6 THEN 'START_SERVICE'
                  WHEN 7 THEN 'GET_PROVIDER'
                  WHEN 8 THEN 'REMOVE_PROVIDER'
                  WHEN 9 THEN 'UI_VISIBILITY'
                  WHEN 10 THEN 'ALLOWLIST'
                  WHEN 11 THEN 'PROCESS_BEGIN'
                  WHEN 12 THEN 'PROCESS_END'
                  WHEN 13 THEN 'SHORT_FGS_TIMEOUT'
                  WHEN 14 THEN 'SYSTEM_INIT'
                  WHEN 15 THEN 'BACKUP'
                  WHEN 16 THEN 'SHELL'
                  WHEN 17 THEN 'REMOVE_TASK'
                  WHEN 18 THEN 'UID_IDLE'
                  WHEN 19 THEN 'STOP_SERVICE'
                  WHEN 20 THEN 'EXECUTING_SERVICE'
                  WHEN 21 THEN 'RESTRICTION_CHANGE'
                  WHEN 22 THEN 'COMPONENT_DISABLED'
                  WHEN 23 THEN 'FOLLOW_UP'
                  WHEN 24 THEN 'RECONFIGURATION'
                  WHEN 25 THEN 'SERVICE_BINDER_CALL'
                  WHEN 26 THEN 'BATCH_UPDATE_REQUEST'
                  ELSE 'reason_' || oom_adj_reason
                END AS name
            FROM android_process_state_snapshot
          `,
        }),
        detailsPanel: (row: {readonly ts: bigint}) =>
          this.makeSnapshotDetailsPanel(trace, row.ts),
      }),
    });
    const trackNode = new TrackNode({
      name: 'ProcessStateController snapshots',
      uri: trackUri,
      sortOrder: -7,
    });
    trace.defaultWorkspace.addChildInOrder(trackNode);

    const firstTs = this.snapshots[0].ts;
    const lastTs = this.snapshots[this.snapshots.length - 1].ts;
    trace.scrollTo({
      time: {
        start: Time.fromRaw(BigInt(firstTs)),
        end: Time.fromRaw(BigInt(lastTs)),
        behavior: {viewPercentage: 0.9},
      },
    });
  }

  private makeSnapshotDetailsPanel(
    trace: Trace,
    ts: bigint,
  ): TrackEventDetailsPanel {
    const idx = this.snapshots.findIndex((s) => BigInt(s.ts) === ts);
    return {
      load: async () => {
        if (idx >= 0 && idx !== this.currentIdx) {
          await this.loadSnapshot(trace, idx);
        }
        window.location.hash = PAGE_HASH;
      },
      render: () => {
        if (idx < 0) return m('p', `No snapshot at ts=${ts}.`);
        const s = this.snapshots[idx];
        return m(
          'div',
          {style: {padding: '8px'}},
          m(
            'p',
            'Snapshot ',
            m('strong', `${idx + 1}/${this.snapshots.length}`),
            ` — ts=${s.ts}, reason=${oomAdjReasonName(s.oomAdjReason)},` +
              ` ${s.isFull ? 'anchor' : 'delta'}.`,
          ),
          m(
            'p',
            'Open ',
            m('strong', PAGE_TITLE),
            ' from the sidebar for the Table / Binding Graph / Bindings views.',
          ),
        );
      },
    };
  }

  private async loadSnapshot(trace: Trace, idx: number): Promise<void> {
    if (idx < 0 || idx >= this.snapshots.length) return;
    const seq = ++this.loadSeq;
    const snapId = this.snapshots[idx].id;

    const procRes = await trace.engine.query(
      `WITH latest_per_pid AS (
         SELECT p.*,
                ROW_NUMBER() OVER (PARTITION BY pid
                                   ORDER BY snapshot_id DESC) AS rn
         FROM android_process_state_process p
         WHERE p.snapshot_id <= ${snapId}
       )
       SELECT pid, uid, user_id, process_name, package_name,
              cur_adj, set_adj, max_adj,
              cur_proc_state, cur_capability, cur_sched_group,
              has_foreground_activities, has_top_ui, has_overlay_ui,
              has_visible_activities, has_started_services, persistent,
              isolated, has_active_instrumentation, lru_index
       FROM latest_per_pid
       WHERE rn = 1
       ORDER BY cur_adj ASC, lru_index ASC`,
    );
    const rows: ProcessRow[] = [];
    const it = procRes.iter({
      pid: NUM,
      uid: NUM,
      user_id: NUM,
      process_name: STR_NULL,
      package_name: STR_NULL,
      cur_adj: NUM_NULL,
      set_adj: NUM_NULL,
      max_adj: NUM_NULL,
      cur_proc_state: NUM_NULL,
      cur_capability: NUM_NULL,
      cur_sched_group: NUM_NULL,
      has_foreground_activities: NUM_NULL,
      has_top_ui: NUM_NULL,
      has_overlay_ui: NUM_NULL,
      has_visible_activities: NUM_NULL,
      has_started_services: NUM_NULL,
      // The producer's ProtoOutputStream elides default `false` /
      // default `0` values on the wire, so these columns can come
      // back NULL even though the producer logically sets them on
      // every emission. Read as nullable and coerce to 0.
      persistent: NUM_NULL,
      isolated: NUM_NULL,
      has_active_instrumentation: NUM_NULL,
      lru_index: NUM_NULL,
    });
    for (; it.valid(); it.next()) {
      rows.push({
        pid: it.pid,
        uid: it.uid,
        userId: it.user_id,
        processName: it.process_name,
        packageName: it.package_name,
        curAdj: it.cur_adj,
        setAdj: it.set_adj,
        maxAdj: it.max_adj,
        curProcState: it.cur_proc_state,
        curCapability: it.cur_capability,
        curSchedGroup: it.cur_sched_group,
        hasForegroundActivities: (it.has_foreground_activities ?? 0) === 1,
        hasTopUi: (it.has_top_ui ?? 0) === 1,
        hasOverlayUi: (it.has_overlay_ui ?? 0) === 1,
        hasVisibleActivities: (it.has_visible_activities ?? 0) === 1,
        hasStartedServices: (it.has_started_services ?? 0) === 1,
        persistent: (it.persistent ?? 0) === 1,
        isolated: (it.isolated ?? 0) === 1,
        hasActiveInstrumentation: (it.has_active_instrumentation ?? 0) === 1,
        lruIndex: it.lru_index ?? 0,
      });
    }

    const edges: AnchorEdge[] = [];
    try {
      const er = await trace.engine.query(
        `WITH latest_b AS (
           SELECT b.*,
                  ROW_NUMBER() OVER (PARTITION BY binding_id
                                     ORDER BY snapshot_id DESC) AS rn
           FROM android_process_state_binding b
           WHERE b.snapshot_id <= ${snapId}
         ),
         latest_s AS (
           SELECT s.*,
                  ROW_NUMBER() OVER (PARTITION BY service_id
                                     ORDER BY snapshot_id DESC) AS rn
           FROM android_process_state_service s
           WHERE s.snapshot_id <= ${snapId}
         )
         SELECT b.client_pid, s.owning_pid AS owner_pid,
                b.flag_auto_create, b.flag_foreground_service,
                b.flag_not_foreground, b.flag_above_client,
                b.flag_allow_oom_management, b.flag_waive_priority,
                b.flag_important, b.flag_adjust_with_activity,
                b.flag_include_capabilities, s.short_name
         FROM latest_b b
         LEFT JOIN latest_s s ON s.service_id = b.service_id AND s.rn = 1
         WHERE b.rn = 1`,
      );
      const eit = er.iter({
        client_pid: NUM,
        owner_pid: NUM,
        // Booleans below come back nullable: ProtoOutputStream
        // elides default-false values on the wire, so trace_processor
        // surfaces NULL where the producer sent nothing.
        flag_auto_create: NUM_NULL,
        flag_foreground_service: NUM_NULL,
        flag_not_foreground: NUM_NULL,
        flag_above_client: NUM_NULL,
        flag_allow_oom_management: NUM_NULL,
        flag_waive_priority: NUM_NULL,
        flag_important: NUM_NULL,
        flag_adjust_with_activity: NUM_NULL,
        flag_include_capabilities: NUM_NULL,
        short_name: STR_NULL,
      });
      for (; eit.valid(); eit.next()) {
        if (eit.client_pid === 0 || eit.owner_pid === 0) continue;
        if (eit.client_pid === eit.owner_pid) continue;
        edges.push({
          kind: 'service',
          clientPid: eit.client_pid,
          ownerPid: eit.owner_pid,
          flagAutoCreate: (eit.flag_auto_create ?? 0) === 1,
          flagForegroundService: (eit.flag_foreground_service ?? 0) === 1,
          flagNotForeground: (eit.flag_not_foreground ?? 0) === 1,
          flagAboveClient: (eit.flag_above_client ?? 0) === 1,
          flagAllowOomManagement: (eit.flag_allow_oom_management ?? 0) === 1,
          flagWaivePriority: (eit.flag_waive_priority ?? 0) === 1,
          flagImportant: (eit.flag_important ?? 0) === 1,
          flagAdjustWithActivity: (eit.flag_adjust_with_activity ?? 0) === 1,
          flagIncludeCapabilities: (eit.flag_include_capabilities ?? 0) === 1,
          shortName: eit.short_name,
        });
      }
    } catch (_e) {
      // older trace_processor without the binding table — tolerate
    }

    try {
      const pr = await trace.engine.query(
        `WITH latest_pb AS (
           SELECT pb.*,
                  ROW_NUMBER() OVER (PARTITION BY binding_id
                                     ORDER BY snapshot_id DESC) AS rn
           FROM android_process_state_provider_binding pb
           WHERE pb.snapshot_id <= ${snapId}
         ),
         latest_p AS (
           SELECT p.*,
                  ROW_NUMBER() OVER (PARTITION BY provider_id
                                     ORDER BY snapshot_id DESC) AS rn
           FROM android_process_state_provider p
           WHERE p.snapshot_id <= ${snapId}
         )
         SELECT pb.client_pid, p.owning_pid AS owner_pid,
                p.authority, p.package_name, p.class_name,
                pb.stable_count, pb.unstable_count, pb.dead, pb.waiting
         FROM latest_pb pb
         LEFT JOIN latest_p p
           ON p.provider_id = pb.provider_id AND p.rn = 1
         WHERE pb.rn = 1`,
      );
      const pit = pr.iter({
        client_pid: NUM,
        owner_pid: NUM_NULL,
        authority: STR_NULL,
        package_name: STR_NULL,
        class_name: STR_NULL,
        stable_count: NUM,
        unstable_count: NUM,
        dead: NUM,
        waiting: NUM,
      });
      for (; pit.valid(); pit.next()) {
        const ownerPid = pit.owner_pid ?? 0;
        if (pit.client_pid === 0 || ownerPid === 0) continue;
        if (pit.client_pid === ownerPid) continue;
        edges.push({
          kind: 'provider',
          clientPid: pit.client_pid,
          ownerPid,
          authority: pit.authority,
          packageName: pit.package_name,
          className: pit.class_name,
          stableCount: pit.stable_count,
          unstableCount: pit.unstable_count,
          dead: pit.dead === 1,
          waiting: pit.waiting === 1,
        });
      }
    } catch (_e) {
      // older trace_processor without provider tables — tolerate
    }

    if (seq !== this.loadSeq) return;
    this.currentIdx = idx;
    this.currentRows = rows;
    this.currentEdges = edges;
    const idx_ = new Map<number, ProcessRow>();
    for (const r of rows) idx_.set(r.pid, r);
    this.procByPid = idx_;

    for (const pid of this.selectedPids) {
      if (!idx_.has(pid)) this.selectedPids.delete(pid);
    }
  }

  // setSelection focuses on a pid plus its immediate neighbours.
  // The graph and Bindings views render selectedPids strictly, so
  // the selection IS the visible set — selecting through the filter
  // shows exactly those processes; clicking a node expands the set
  // to the clicked pid plus its neighbours.
  private setSelection(pid: number): void {
    const next = new Set<number>([pid]);
    for (const e of this.currentEdges) {
      if (e.clientPid === pid) next.add(e.ownerPid);
      if (e.ownerPid === pid) next.add(e.clientPid);
    }
    this.selectedPids = next;
    m.redraw();
  }

  private gotoSnapshot(trace: Trace, idx: number): void {
    if (idx < 0 || idx >= this.snapshots.length) return;
    void this.loadSnapshot(trace, idx);
  }

  private renderPage(_trace: Trace): m.Children {
    const cur = this.snapshots[this.currentIdx];
    if (cur === undefined) {
      return m(
        'div',
        {class: 'pse-page'},
        m(
          'div',
          {class: 'pse-empty-state'},
          'No android.process_state data in this trace.',
        ),
      );
    }

    const tabs: TabsTab[] = [
      {
        key: TAB_TABLE,
        title: 'Table',
        content: this.renderTable(),
      },
      {
        key: TAB_GRAPH,
        title: 'Binding Graph',
        content: this.renderGraph(),
      },
      {
        key: TAB_BINDINGS,
        title: 'Bindings',
        content: this.renderBindings(),
      },
    ];

    const subtitle = m(
      'div',
      {class: 'pse-context'},
      cur.isFull ? 'anchor' : 'delta',
      ' · ',
      oomAdjReasonName(cur.oomAdjReason),
      cur.topPid !== null ? ` · top pid ${cur.topPid}` : '',
    );
    return m(
      'div',
      {class: 'pse-page'},
      this.renderHeader(_trace, cur),
      m(
        'div',
        {class: 'pse-main'},
        subtitle,
        m(Tabs, {
          tabs,
          activeTabKey: this.activeTab,
          onTabChange: (key: string) => {
            if (
              key === TAB_TABLE ||
              key === TAB_GRAPH ||
              key === TAB_BINDINGS
            ) {
              this.activeTab = key;
            }
          },
          rightContent: this.renderProcessFilter(),
        }),
      ),
    );
  }

  private renderHeader(trace: Trace, _cur: SnapshotMeta): m.Children {
    const idx = this.currentIdx;
    const last = this.snapshots.length - 1;
    return m(
      'div',
      {class: 'pse-header'},
      m(
        'div',
        {class: 'pse-header__left'},
        m(
          'span',
          {class: 'pse-header__pos'},
          `Snapshot ${idx + 1} / ${this.snapshots.length}`,
        ),
      ),
      m(
        'div',
        {class: 'pse-header__right'},
        m(Button, {
          icon: 'navigate_before',
          label: 'Prev',
          disabled: idx <= 0,
          onclick: () => this.gotoSnapshot(trace, idx - 1),
        }),
        m(Button, {
          icon: 'navigate_next',
          label: 'Next',
          disabled: idx >= last,
          onclick: () => this.gotoSnapshot(trace, idx + 1),
        }),
      ),
    );
  }

  private renderProcessFilter(): m.Children {
    const sorted = [...this.currentRows].sort(
      (a, b) => (a.curAdj ?? 1000) - (b.curAdj ?? 1000),
    );
    const options: MultiSelectOption[] = sorted.map((r) => ({
      id: String(r.pid),
      name:
        `${r.processName ?? `pid ${r.pid}`}` +
        ` (pid ${r.pid}, adj=${r.curAdj ?? '?'})`,
      checked: this.selectedPids.has(r.pid),
    }));
    const n = this.selectedPids.size;
    const label =
      n === 0
        ? 'Filter processes'
        : `${n} process${n === 1 ? '' : 'es'} selected`;
    return m(
      'div',
      {class: 'pse-tab-rightcontent'},
      m(PopupMultiSelect, {
        label,
        icon: Icons.Filter,
        position: PopupPosition.Bottom,
        options,
        repeatCheckedItemsAtTop: true,
        showNumSelected: true,
        onChange: (diffs: MultiSelectDiff[]) => {
          for (const {id, checked} of diffs) {
            const pid = Number(id);
            if (Number.isNaN(pid)) continue;
            if (checked) this.selectedPids.add(pid);
            else this.selectedPids.delete(pid);
          }
          m.redraw();
        },
      }),
      n > 0
        ? m(Button, {
            label: 'Clear',
            onclick: () => {
              this.selectedPids.clear();
              m.redraw();
            },
          })
        : null,
    );
  }

  private renderTable(): m.Children {
    const rows =
      this.selectedPids.size === 0
        ? this.currentRows.slice()
        : this.currentRows.filter((r) => this.selectedPids.has(r.pid));
    rows.sort(
      (a, b) =>
        (a.curAdj ?? 1000) - (b.curAdj ?? 1000) || a.lruIndex - b.lruIndex,
    );

    return m(
      'div',
      {class: 'pse-view'},
      m(Grid, {
        fillHeight: true,
        columns: [
          {key: 'pid', header: m(GridHeaderCell, 'pid')},
          {key: 'uid', header: m(GridHeaderCell, 'uid')},
          {key: 'process', header: m(GridHeaderCell, 'process')},
          {key: 'curAdj', header: m(GridHeaderCell, 'cur_adj')},
          {key: 'tier', header: m(GridHeaderCell, 'tier')},
          {key: 'setAdj', header: m(GridHeaderCell, 'set_adj')},
          {key: 'maxAdj', header: m(GridHeaderCell, 'max_adj')},
          {key: 'procState', header: m(GridHeaderCell, 'procState')},
          {key: 'capability', header: m(GridHeaderCell, 'cap')},
          {key: 'sched', header: m(GridHeaderCell, 'sched')},
          {key: 'flags', header: m(GridHeaderCell, 'flags')},
        ],
        rowData: rows.map((r) => {
          const pidCell = m(
            GridCell,
            m(
              'button.pse-pid-link',
              {
                'type': 'button',
                'aria-label': `Focus pid ${r.pid}`,
                'onclick': () => this.setSelection(r.pid),
              },
              String(r.pid),
            ),
          );
          const processCell = m(
            GridCell,
            r.processName ?? '-',
            r.packageName !== null && r.packageName !== r.processName
              ? ` (${r.packageName})`
              : '',
          );
          const flagSummary = (() => {
            const f: string[] = [];
            if (r.persistent) f.push('persistent');
            if (r.hasTopUi) f.push('top-ui');
            if (r.hasOverlayUi) f.push('overlay');
            if (r.hasForegroundActivities) f.push('fg-act');
            if (r.hasVisibleActivities) f.push('vis-act');
            if (r.hasStartedServices) f.push('started-svc');
            if (r.hasActiveInstrumentation) f.push('instr');
            return f.length === 0 ? '-' : f.join(' ');
          })();
          return [
            pidCell,
            m(GridCell, String(r.uid)),
            processCell,
            m(GridCell, r.curAdj === null ? '-' : String(r.curAdj)),
            m(GridCell, adjTierName(r.curAdj)),
            m(GridCell, r.setAdj === null ? '-' : String(r.setAdj)),
            m(GridCell, r.maxAdj === null ? '-' : String(r.maxAdj)),
            m(GridCell, r.curProcState === null ? '-' : String(r.curProcState)),
            m(GridCell, capabilitySummary(r.curCapability)),
            m(
              GridCell,
              r.curSchedGroup === null ? '-' : String(r.curSchedGroup),
            ),
            m(GridCell, flagSummary),
          ];
        }),
      }),
    );
  }

  private renderGraph(): m.Children {
    const procByPid = this.procByPid;
    const want = new Set<number>();
    if (this.selectedPids.size > 0) {
      // Strict membership: render exactly the selected set. Click
      // handlers populate selectedPids with a pid plus its immediate
      // neighbours, so a single click produces a focused subgraph.
      for (const pid of this.selectedPids) want.add(pid);
    } else {
      for (const e of this.currentEdges) {
        want.add(e.clientPid);
        want.add(e.ownerPid);
      }
      for (const r of this.currentRows) {
        if (
          r.persistent ||
          r.hasTopUi ||
          r.hasForegroundActivities ||
          r.hasVisibleActivities ||
          r.hasStartedServices ||
          r.hasActiveInstrumentation ||
          (r.curAdj !== null && r.curAdj <= 200)
        ) {
          want.add(r.pid);
        }
      }
    }

    const nodes: ForceGraphNode[] = [];
    for (const pid of want) {
      const r = procByPid.get(pid);
      if (r === undefined) continue;
      const adj = r.curAdj ?? 1000;
      const radius = adj <= 0 ? 11 : adj <= 200 ? 9 : adj <= 500 ? 7 : 5;
      nodes.push({
        id: r.pid,
        label: shortenLabel(r.processName ?? `pid ${r.pid}`),
        color: nodeColor(r),
        radius,
      });
    }
    if (nodes.length === 0) {
      return m(
        'div',
        {class: 'pse-view'},
        m(
          'div',
          {class: 'pse-empty-state'},
          this.selectedPids.size > 0
            ? 'No bindings touch the selected processes at this snapshot.'
            : 'This snapshot has no bindings and no processes with intrinsic ' +
                'priority. Step through snapshots with the Prev / Next ' +
                'buttons or click a marker on the timeline track.',
        ),
      );
    }
    const present = new Set(nodes.map((n) => n.id));
    const links = this.currentEdges
      .filter((e) => present.has(e.clientPid) && present.has(e.ownerPid))
      .map((e) => {
        if (e.kind === 'service') {
          return {
            source: e.clientPid,
            target: e.ownerPid,
            color: e.flagForegroundService ? '#e74c3c' : '#9aa0a6',
            width: e.flagForegroundService ? 1.8 : 0.8,
          };
        }
        return {
          source: e.clientPid,
          target: e.ownerPid,
          color: e.stableCount > 0 ? '#1976d2' : '#90caf9',
          width: e.stableCount > 0 ? 1.4 : 0.6,
        };
      });

    return m(
      'div',
      {class: 'pse-view pse-view--graph'},
      m(
        'div',
        {class: 'pse-graph-legend'},
        m(
          'span',
          {class: 'pse-graph-legend__hint'},
          'drag to pan · scroll to zoom · click a node to focus',
        ),
        m(
          'span',
          m('span', {
            class: 'pse-graph-legend__swatch',
            style: {background: '#9aa0a6'},
          }),
          'service',
        ),
        m(
          'span',
          m('span', {
            class: 'pse-graph-legend__swatch',
            style: {background: '#e74c3c'},
          }),
          'foreground service',
        ),
        m(
          'span',
          m('span', {
            class: 'pse-graph-legend__swatch',
            style: {background: '#1976d2'},
          }),
          'content provider',
        ),
      ),
      m(
        'div',
        {
          class: 'pse-graph-host',
          oncreate: (vnode: m.VnodeDOM) => {
            const el = vnode.dom as HTMLElement;
            let pendingFrame = 0;
            const measure = () => {
              pendingFrame = 0;
              const w = Math.max(400, el.clientWidth);
              const h = Math.max(360, el.clientHeight);
              if (w !== this.graphWidth || h !== this.graphHeight) {
                this.graphWidth = w;
                this.graphHeight = h;
                m.redraw();
              }
            };
            const ro = new ResizeObserver(() => {
              if (pendingFrame !== 0) return;
              pendingFrame = requestAnimationFrame(measure);
            });
            ro.observe(el);
            requestAnimationFrame(measure);
            (vnode.state as {ro?: ResizeObserver}).ro = ro;
          },
          onremove: (vnode: m.VnodeDOM) => {
            const ro = (vnode.state as {ro?: ResizeObserver}).ro;
            ro?.disconnect();
          },
        },
        m(ForceGraph, {
          nodes,
          links,
          width: this.graphWidth,
          height: this.graphHeight,
          // Stronger repulsion sparses a dense binding graph; the
          // widget default (80) clusters too tightly.
          repulsion: 240,
          linkDistance: 90,
          onNodeClick: (id) => {
            if (typeof id === 'number') {
              this.setSelection(id);
            }
          },
        }),
      ),
    );
  }

  private renderBindings(): m.Children {
    if (this.selectedPids.size === 0) {
      return m(
        'div',
        {class: 'pse-view'},
        m(
          'div',
          {class: 'pse-empty-state'},
          'Select one or more processes from the filter (or click a node ' +
            'in the Binding Graph) to see their inbound and outbound ' +
            'service + content-provider bindings, and what is keeping each ' +
            'one alive at its current adj.',
        ),
      );
    }
    const sorted = [...this.selectedPids]
      .map((pid) => this.procByPid.get(pid))
      .filter((r): r is ProcessRow => r !== undefined)
      .sort((a, b) => (a.curAdj ?? 1000) - (b.curAdj ?? 1000));
    return m(
      'div',
      {class: 'pse-view'},
      ...sorted.map((r) => this.renderBindingsCard(r)),
    );
  }

  private renderBindingsCard(r: ProcessRow): m.Children {
    const inbound = [
      ...this.currentEdges.filter((e) => e.ownerPid === r.pid),
    ].sort((a, b) => {
      const ca = this.procByPid.get(a.clientPid);
      const cb = this.procByPid.get(b.clientPid);
      return (ca?.curAdj ?? 1000) - (cb?.curAdj ?? 1000);
    });
    const outbound = this.currentEdges.filter((e) => e.clientPid === r.pid);
    const chain = this.explainWhyAlive(r.pid);
    const uniqueIn = uniqueEdgeCount(inbound, 'inbound');
    const uniqueOut = uniqueEdgeCount(outbound, 'outbound');
    return m(
      'section',
      {class: 'pse-card', key: r.pid},
      m(
        'h2',
        {class: 'pse-card__title'},
        `pid ${r.pid} — ${r.processName ?? '-'}`,
      ),
      m(
        'div',
        {class: 'pse-chips'},
        m(Chip, {label: `cur_adj=${r.curAdj ?? '?'}`}),
        m(Chip, {label: `tier ${adjTierName(r.curAdj)}`}),
        m(Chip, {label: `proc_state=${r.curProcState ?? '?'}`}),
        m(Chip, {label: capabilitySummary(r.curCapability)}),
        m(Chip, {label: `sched=${r.curSchedGroup ?? '?'}`}),
      ),
      m('h3', {class: 'pse-sub-heading'}, 'Why this process is at this adj'),
      this.renderWhyAliveChain(r, chain),
      m(
        'h3',
        {class: 'pse-sub-heading', style: {marginTop: '1rem'}},
        `Inbound · ${uniqueIn} ` +
          `${uniqueIn === 1 ? 'binding' : 'bindings'} ` +
          `(client → this process; sorted by client adj)`,
      ),
      inbound.length === 0
        ? m(
            'div',
            {
              class: 'pse-empty-state',
              style: {padding: '0.5rem', textAlign: 'left'},
            },
            '(none)',
          )
        : this.renderEdgeGrid(inbound, 'inbound'),
      m(
        'h3',
        {class: 'pse-sub-heading', style: {marginTop: '1rem'}},
        `Outbound · ${uniqueOut} ` +
          `${uniqueOut === 1 ? 'binding' : 'bindings'} ` +
          `(this process → owner; processes this one keeps alive)`,
      ),
      outbound.length === 0
        ? m(
            'div',
            {
              class: 'pse-empty-state',
              style: {padding: '0.5rem', textAlign: 'left'},
            },
            '(none)',
          )
        : this.renderEdgeGrid(outbound, 'outbound'),
    );
  }

  private renderWhyAliveChain(
    focusedRow: ProcessRow,
    reason: WhyAliveReason,
  ): m.Children {
    const chainRows = this.flattenChain(focusedRow, reason);
    return m(Grid, {
      columns: [
        {key: 'level', header: m(GridHeaderCell, '#')},
        {key: 'kind', header: m(GridHeaderCell, 'kind')},
        {key: 'process', header: m(GridHeaderCell, 'process')},
        {key: 'adj', header: m(GridHeaderCell, 'cur_adj')},
        {key: 'via', header: m(GridHeaderCell, 'flags / refs')},
        {key: 'endpoint', header: m(GridHeaderCell, 'endpoint')},
        {key: 'notes', header: m(GridHeaderCell, 'why')},
      ],
      rowData: chainRows.map((row) => [
        m(GridCell, String(row.level)),
        m(GridCell, row.kind),
        m(GridCell, row.processLabel),
        m(GridCell, row.adj === null ? '-' : String(row.adj)),
        m(GridCell, row.via ?? '-'),
        m(GridCell, row.endpoint ?? '-'),
        m(GridCell, row.notes),
      ]),
    });
  }

  private flattenChain(
    focused: ProcessRow,
    reason: WhyAliveReason,
  ): Array<{
    level: number;
    kind: string;
    processLabel: string;
    adj: number | null;
    via: string | null;
    endpoint: string | null;
    notes: m.Children;
  }> {
    const rows: Array<{
      level: number;
      kind: string;
      processLabel: string;
      adj: number | null;
      via: string | null;
      endpoint: string | null;
      notes: m.Children;
    }> = [];
    let level = 0;
    let cur: ProcessRow = focused;
    let curReason: WhyAliveReason = reason;
    while (curReason.kind === 'inherited') {
      const semantic = edgeAnchorNotes(curReason.edge);
      const parentName =
        curReason.parentRow.processName ?? `pid ${curReason.parentRow.pid}`;
      const heading =
        `Anchored by ${parentName} ` +
        `(adj ${curReason.parentRow.curAdj ?? '?'})`;
      const noteChildren: m.Children[] = [m('div', heading)];
      for (const note of semantic) {
        noteChildren.push(
          m(
            'div',
            {style: {color: 'var(--pf-color-text-hint)', fontSize: '11px'}},
            note,
          ),
        );
      }
      rows.push({
        level,
        kind: curReason.edge.kind,
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: edgeFlagsSummary(curReason.edge),
        endpoint: edgeEndpointLabel(curReason.edge),
        notes: m('div', noteChildren),
      });
      level += 1;
      cur = curReason.parentRow;
      curReason = curReason.upstream;
    }
    if (curReason.kind === 'intrinsic') {
      const flagText =
        curReason.flags.length === 0
          ? `at the ${adjTierName(cur.curAdj)} tier`
          : curReason.flags.join(', ');
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m('span', m('strong', 'Intrinsic: '), flagText),
      });
    } else if (curReason.kind === 'cached') {
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m(
          'span',
          m('strong', 'Cached. '),
          'No intrinsic state and no inbound bindings; the OomAdjuster ' +
            'will reclaim this process under memory pressure.',
        ),
      });
    } else if (curReason.kind === 'persistent-proc') {
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m(
          'span',
          m('strong', `PERSISTENT_PROC tier (adj ${curReason.curAdj}). `),
          'Reserved for system_server and apps marked ' +
            'android:persistent=true; the OomAdjuster floor is set ' +
            'directly, not via a binding.',
        ),
      });
    } else if (curReason.kind === 'persistent-service') {
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m(
          'span',
          m('strong', `PERSISTENT_SERVICE tier (adj ${curReason.curAdj}). `),
          'Priority is inherited from the hosting persistent app, not ' +
            'from a binding in the captured snapshot.',
        ),
      });
    } else if (curReason.kind === 'data-gap') {
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m(
          'span',
          m('strong', `Data gap (adj ${curReason.curAdj}). `),
          'No intrinsic flag or inbound binding in this snapshot ' +
            'accounts for the system-priority adj. Typical causes: a ' +
            'BluetoothManager / app-freezer special case, or a binding ' +
            'that existed before this anchor and was not re-emitted.',
        ),
      });
    } else {
      rows.push({
        level,
        kind: '-',
        processLabel: cur.processName ?? `pid ${cur.pid}`,
        adj: cur.curAdj,
        via: null,
        endpoint: null,
        notes: m(
          'span',
          m('strong', 'Cycle. '),
          'The chain folded back on a previously visited process; two ' +
            'or more processes mutually anchor each other.',
        ),
      });
    }
    return rows;
  }

  private explainWhyAlive(
    pid: number,
    visited: Set<number> = new Set(),
  ): WhyAliveReason {
    if (visited.has(pid)) return {kind: 'cycle'};
    visited.add(pid);

    const row = this.procByPid.get(pid);
    if (row === undefined) return {kind: 'cached', curAdj: null};

    const flags: string[] = [];
    if (row.persistent) flags.push('PERSISTENT');
    if (row.hasTopUi) flags.push('top-ui');
    if (row.hasOverlayUi) flags.push('overlay-ui');
    if (row.hasForegroundActivities) flags.push('fg-activity');
    if (row.hasVisibleActivities) flags.push('visible-activity');
    if (row.hasStartedServices) flags.push('started-service');
    if (row.hasActiveInstrumentation) flags.push('instr');
    if (flags.length > 0) {
      return {kind: 'intrinsic', flags};
    }

    const NOT_FG_CLAMP = 200;
    const candidates = this.currentEdges
      .filter((e) => {
        if (e.ownerPid !== pid) return false;
        if (e.kind === 'service') {
          return !e.flagWaivePriority && !e.flagAboveClient;
        }
        return !e.dead;
      })
      .map((e) => {
        const client = this.procByPid.get(e.clientPid);
        if (client === undefined) return null;
        let effective = client.curAdj ?? 1000;
        if (
          e.kind === 'service' &&
          e.flagNotForeground &&
          effective < NOT_FG_CLAMP
        ) {
          effective = NOT_FG_CLAMP;
        }
        return {edge: e, client, effective};
      })
      .filter(
        (x): x is {edge: AnchorEdge; client: ProcessRow; effective: number} =>
          x !== null,
      )
      .sort((a, b) => a.effective - b.effective);

    if (candidates.length === 0) {
      const adj = row.curAdj;
      if (adj === null || adj > 500) {
        return {kind: 'cached', curAdj: adj};
      }
      // PERSISTENT_PROC_ADJ tier (-800 and below) — system_server
      // and persistent apps. The producer's `persistent` boolean is
      // not always set for system_server itself, so detect the tier
      // from the adj value.
      if (adj <= -800) {
        return {kind: 'persistent-proc', curAdj: adj};
      }
      if (adj <= -700) {
        return {kind: 'persistent-service', curAdj: adj};
      }
      return {kind: 'data-gap', curAdj: adj};
    }
    const top = candidates[0];
    return {
      kind: 'inherited',
      parentPid: top.client.pid,
      parentRow: top.client,
      edge: top.edge,
      upstream: this.explainWhyAlive(top.client.pid, visited),
    };
  }

  private renderEdgeGrid(
    edges: ReadonlyArray<AnchorEdge>,
    kind: 'inbound' | 'outbound',
  ): m.Children {
    const peerLabel = kind === 'inbound' ? 'client' : 'owner';
    // Producer emits one row per ConnectionRecord, so a client that
    // binds to the same service via N ServiceConnections produces N
    // identical-looking rows. Collapse and surface the multiplicity
    // in a `count` column.
    const grouped = new Map<string, {edge: AnchorEdge; count: number}>();
    for (const e of edges) {
      const peerPid = kind === 'inbound' ? e.clientPid : e.ownerPid;
      const key = [
        e.kind,
        peerPid,
        edgeEndpointLabel(e),
        edgeFlagsSummary(e),
      ].join('|');
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {edge: e, count: 1});
      } else {
        existing.count += 1;
      }
    }
    return m(Grid, {
      columns: [
        {key: 'kind', header: m(GridHeaderCell, 'kind')},
        {key: 'count', header: m(GridHeaderCell, '#')},
        {key: 'peer_pid', header: m(GridHeaderCell, `${peerLabel} pid`)},
        {key: 'peer', header: m(GridHeaderCell, peerLabel)},
        {key: 'peer_adj', header: m(GridHeaderCell, `${peerLabel} adj`)},
        {key: 'endpoint', header: m(GridHeaderCell, 'endpoint')},
        {key: 'flags', header: m(GridHeaderCell, 'flags / refs')},
      ],
      rowData: [...grouped.values()].map(({edge: e, count}) => {
        const peerPid = kind === 'inbound' ? e.clientPid : e.ownerPid;
        const peer = this.procByPid.get(peerPid);
        return [
          m(GridCell, e.kind),
          m(GridCell, String(count)),
          m(GridCell, String(peerPid)),
          m(GridCell, peer?.processName ?? `pid ${peerPid}`),
          m(
            GridCell,
            peer?.curAdj === undefined || peer?.curAdj === null
              ? '-'
              : String(peer.curAdj),
          ),
          m(GridCell, edgeEndpointLabel(e)),
          m(GridCell, edgeFlagsSummary(e)),
        ];
      }),
    });
  }
}

function uniqueEdgeCount(
  edges: ReadonlyArray<AnchorEdge>,
  kind: 'inbound' | 'outbound',
): number {
  const seen = new Set<string>();
  for (const e of edges) {
    const peer = kind === 'inbound' ? e.clientPid : e.ownerPid;
    seen.add(
      [e.kind, peer, edgeEndpointLabel(e), edgeFlagsSummary(e)].join('|'),
    );
  }
  return seen.size;
}

function adjTierName(adj: number | null): string {
  if (adj === null) return 'unknown';
  if (adj <= -800) return 'PERSISTENT';
  if (adj <= -700) return 'PERSISTENT_SERVICE';
  if (adj <= 0) return 'FOREGROUND';
  if (adj <= 50) return 'PERCEPTIBLE_RECENT_FG';
  if (adj <= 100) return 'VISIBLE';
  if (adj <= 200) return 'PERCEPTIBLE';
  if (adj <= 300) return 'BACKUP';
  if (adj <= 400) return 'HEAVY_WEIGHT';
  if (adj <= 500) return 'SERVICE';
  if (adj <= 600) return 'HOME';
  if (adj <= 700) return 'PREVIOUS';
  if (adj <= 800) return 'SERVICE_B';
  if (adj <= 999) return 'CACHED';
  return 'UNKNOWN';
}

const OOM_ADJ_REASON_NAMES: ReadonlyArray<string> = [
  'NONE',
  'ACTIVITY',
  'FINISH_RECEIVER',
  'START_RECEIVER',
  'BIND_SERVICE',
  'UNBIND_SERVICE',
  'START_SERVICE',
  'GET_PROVIDER',
  'REMOVE_PROVIDER',
  'UI_VISIBILITY',
  'ALLOWLIST',
  'PROCESS_BEGIN',
  'PROCESS_END',
  'SHORT_FGS_TIMEOUT',
  'SYSTEM_INIT',
  'BACKUP',
  'SHELL',
  'REMOVE_TASK',
  'UID_IDLE',
  'STOP_SERVICE',
  'EXECUTING_SERVICE',
  'RESTRICTION_CHANGE',
  'COMPONENT_DISABLED',
  'FOLLOW_UP',
  'RECONFIGURATION',
  'SERVICE_BINDER_CALL',
  'BATCH_UPDATE_REQUEST',
];

function oomAdjReasonName(n: number): string {
  return OOM_ADJ_REASON_NAMES[n] ?? `reason_${n}`;
}

function edgeEndpointLabel(e: AnchorEdge): string {
  if (e.kind === 'service') {
    return e.shortName ?? '-';
  }
  return e.authority ?? '-';
}

function edgeFlagsSummary(e: AnchorEdge): string {
  if (e.kind === 'service') {
    const flags: string[] = [];
    if (e.flagWaivePriority) flags.push('WAIVE');
    if (e.flagAboveClient) flags.push('ABOVE_CLIENT');
    if (e.flagForegroundService) flags.push('FGS');
    if (e.flagImportant) flags.push('IMPORTANT');
    if (e.flagNotForeground) flags.push('NOT_FG');
    if (e.flagAdjustWithActivity) flags.push('WITH_ACTIVITY');
    if (e.flagIncludeCapabilities) flags.push('INC_CAPS');
    if (e.flagAllowOomManagement) flags.push('ALLOW_OOM');
    if (e.flagAutoCreate) flags.push('AUTO');
    return flags.length === 0 ? '-' : flags.join(' ');
  }
  const parts: string[] = [];
  if (e.stableCount > 0) parts.push(`stable=${e.stableCount}`);
  if (e.unstableCount > 0) parts.push(`unstable=${e.unstableCount}`);
  if (e.dead) parts.push('DEAD');
  if (e.waiting) parts.push('WAITING');
  return parts.length === 0 ? '-' : parts.join(' ');
}

function edgeAnchorNotes(e: AnchorEdge): ReadonlyArray<string> {
  const notes: string[] = [];
  if (e.kind === 'service') {
    if (e.flagWaivePriority) {
      notes.push('WAIVE_PRIORITY: client does NOT propagate priority');
    }
    if (e.flagAboveClient) {
      notes.push('ABOVE_CLIENT: service kept above client');
    }
    if (e.flagForegroundService) {
      notes.push('FOREGROUND_SERVICE: promotes service into FGS tier');
    }
    if (e.flagNotForeground) {
      notes.push("NOT_FOREGROUND: client's FG/visible state is NOT propagated");
    }
    if (e.flagIncludeCapabilities) {
      notes.push('INCLUDE_CAPABILITIES: client capability bitmask propagates');
    }
    if (e.flagAdjustWithActivity) {
      notes.push(
        "ADJUST_WITH_ACTIVITY: tracks client's visible-activity state",
      );
    }
    if (e.flagAllowOomManagement) {
      notes.push(
        'ALLOW_OOM_MANAGEMENT: service may be killed for memory pressure',
      );
    }
    return notes;
  }
  if (e.stableCount > 0) {
    notes.push(
      `stable=${e.stableCount}: stable refs hold owner at client tier`,
    );
  }
  if (e.unstableCount > 0 && e.stableCount === 0) {
    notes.push(`unstable=${e.unstableCount}: only unstable refs`);
  }
  if (e.dead) {
    notes.push('DEAD: connection dead, no priority propagated');
  }
  if (e.waiting) {
    notes.push('WAITING: initial getProvider() blocked');
  }
  return notes;
}

function capabilityFlagNames(cap: number | null): ReadonlyArray<string> {
  if (cap === null || cap === 0) return [];
  const names: string[] = [];
  if (cap & (1 << 0)) names.push('FG_LOCATION');
  if (cap & (1 << 1)) names.push('FG_CAMERA');
  if (cap & (1 << 2)) names.push('FG_MIC');
  if (cap & (1 << 3)) names.push('POWER_RESTRICTED_NET');
  if (cap & (1 << 4)) names.push('BFSL');
  if (cap & (1 << 5)) names.push('USER_RESTRICTED_NET');
  if (cap & (1 << 6)) names.push('FG_AUDIO_CONTROL');
  if (cap & (1 << 7)) names.push('CPU_TIME');
  if (cap & (1 << 8)) names.push('IMPLICIT_CPU_TIME');
  const known = (1 << 9) - 1;
  const unknown = cap & ~known;
  if (unknown !== 0) names.push(`unknown(0x${unknown.toString(16)})`);
  return names;
}

function capabilitySummary(cap: number | null): string {
  if (cap === null) return 'cap=?';
  if (cap === 0) return 'cap=NONE';
  const names = capabilityFlagNames(cap);
  return names.length === 0 ? `cap=0x${cap.toString(16)}` : names.join(' ');
}

function nodeColor(r: ProcessRow): string {
  if (r.persistent) return '#e8a4a4';
  if (r.hasTopUi) return '#a4d8a4';
  const adj = r.curAdj ?? 1000;
  if (adj <= 0) return '#a4a4d8';
  if (adj <= 200) return '#dcd8a4';
  return '#dddddd';
}

function shortenLabel(s: string): string {
  return s
    .replace(/^com\.android\./, '')
    .replace(/^com\.google\.android\./, 'g.')
    .replace(/^android\./, '')
    .replace(/\.process$/, '');
}
