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
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import type {Trace} from '../../public/trace';
import type {Row} from '../../trace_processor/query_result';
import {NUM, NUM_NULL, STR_NULL} from '../../trace_processor/query_result';
import {ProcessGraph} from './process_graph';
import type {EdgeSel} from './process_graph';
import {gridSchema, gridCard} from './grid_helpers';

export interface ProcessStatePageAttrs {
  readonly trace: Trace;
  readonly subpage?: string;
}

interface Snapshot {
  readonly id: number;
  readonly ts: bigint;
  readonly reason: number;
  // Device-wide context (GlobalState).
  readonly isAwake: boolean;
  readonly unlocking: boolean;
  readonly shade: boolean;
  readonly memNormal: boolean;
  readonly topProcState: number | null;
  readonly homePid: number | null;
  readonly heavyPid: number | null;
  readonly prevPid: number | null;
  readonly dozingPid: number | null;
  readonly idleAllowlist: string;
}

// MutationEvent.Kind -> readable label (mirrors process_state_data.proto).
const KIND_NAME: {readonly [k: number]: string} = {
  1: 'process-begin', 2: 'process-end', 3: 'oom-adj-recompute',
  4: 'service-start', 5: 'service-stop', 6: 'service-bind', 7: 'service-unbind',
  8: 'service-rebind', 9: 'fgs-start', 10: 'fgs-stop', 11: 'fgs-type-change',
  12: 'short-fgs-start', 13: 'short-fgs-timeout',
  20: 'provider-install', 21: 'provider-uninstall', 22: 'provider-bind',
  23: 'provider-unbind', 30: 'broadcast-dispatch-begin', 31: 'broadcast-dispatch-end',
  40: 'uid-proc-state-change', 41: 'uid-idle-change', 42: 'uid-allowlist-change',
  43: 'uid-restriction-change', 50: 'wakefulness-change', 51: 'top-process-change',
  52: 'home-process-change', 53: 'heavy-weight-change', 54: 'previous-process-change',
  55: 'backup-target-change', 56: 'notification-shade-change', 57: 'unlocking-change',
  58: 'memory-level-change', 60: 'frozen-change', 70: 'hosting-type-change',
  71: 'capability-change', 72: 'sched-group-change', 80: 'instrumentation-begin',
  81: 'instrumentation-end',
};

// Synthesize a human-readable "detail" for a mutation-event row from whichever
// fields are relevant to its kind.
const EVENT_COLS = ['ts', 'event', 'pid', 'uid', 'detail'];

function eventDetail(r: Row): string {
  const k = Number(r['kind']);
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  if (k === 30 || k === 31 || (k >= 20 && k <= 23)) return s(r['label']);
  if (k === 60) return Number(r['next_adj']) === 1 ? 'frozen' : 'unfrozen';
  if (k === 58) return `level ${s(r['next_adj'])}`;
  if (k === 40) return `procState ${s(r['next_proc_state'])}`;
  if (k === 3 || k === 71 || k === 72) {
    return `adj ${s(r['prev_adj'])}→${s(r['next_adj'])}` +
      ` · ps ${s(r['prev_proc_state'])}→${s(r['next_proc_state'])}`;
  }
  if (k >= 4 && k <= 13) {
    return r['fg_service_types'] ? `fgsTypes ${s(r['fg_service_types'])}` : '';
  }
  if (k >= 50 && k <= 57) return `${s(r['prev_adj'])}→${s(r['next_adj'])}`;
  return s(r['label']);
}


export class ProcessStatePage implements m.ClassComponent<ProcessStatePageAttrs> {
  private trace!: Trace;
  private snapshots: Snapshot[] = [];
  private idx = 0;
  private selectedPid?: number;
  private loadToken = 0;
  // Snapshot id requested via deep link (#!/process_state/<id>), honored once
  // snapshots load. Lets the details-panel "Open full explorer" button land on
  // the same snapshot the user was looking at in the timeline.
  private wantSnapshotId?: number;

  // Cached per-(snapshot,pid) data sources so the grids keep their sort/filter.
  private procRows: Row[] = [];
  private procDs?: InMemoryDataSource;
  private procCols: string[] = [];
  private inRows: Row[] = [];
  private outRows: Row[] = [];
  private provOutRows: Row[] = [];
  private provInRows: Row[] = [];
  // Combined (service + provider) binding rows per direction, as sortable grids.
  private outAll: Row[] = [];
  private inAll: Row[] = [];
  private outDs?: InMemoryDataSource;
  private inDs?: InMemoryDataSource;
  // oom-adj props / derivation chain / hosted components, all as grid rows.
  private oomAdjRows: Row[] = [];
  private oomAdjDs?: InMemoryDataSource;
  private chainRows: Row[] = [];
  private chainDs?: InMemoryDataSource;
  private hostedAll: Row[] = [];
  private hostedDs?: InMemoryDataSource;
  // Ordered oom-adj "why-chain" for the selected pid + the compute summary.
  private whyRows: Row[] = [];
  private whyCompute?: Row;
  // Snapshot id the shown compute actually came from (may be an earlier one if
  // the process wasn't recomputed in the current snapshot).
  private whyFromSnapId?: number;
  // Mutation events (transitions) captured in the current snapshot window.
  private eventRows: Row[] = [];
  private eventDs?: InMemoryDataSource;
  // Which bottom tab is showing.
  private tab: 'procs' | 'detail' | 'events' = 'procs';
  // The clicked binding edge (drives the detail panel when set).
  private selectedEdge?: EdgeSel;
  // Components the selected process hosts (its own services / providers).
  private hostedSvc: Row[] = [];
  private hostedProv: Row[] = [];

  oninit(vnode: m.Vnode<ProcessStatePageAttrs>) {
    this.trace = vnode.attrs.trace;
    const sub = vnode.attrs.subpage?.replace(/^\//, '');
    if (sub !== undefined && sub !== '' && !Number.isNaN(Number(sub))) {
      this.wantSnapshotId = Number(sub);
    }
    this.loadSnapshots().catch((e) => console.error('ProcessState', e));
  }

  private async loadSnapshots() {
    const q = await this.trace.engine.query(
      `SELECT id, ts, oom_adj_reason AS reason, is_awake, unlocking,
              expanded_notification_shade AS shade,
              last_memory_level_normal AS mem_normal,
              top_process_state, home_pid, heavy_weight_pid, previous_pid,
              dozing_ui_pid, idle_allowlist_appids
       FROM android_process_state_snapshot ORDER BY ts`,
    );
    const it = q.iter({
      id: NUM, ts: NUM, reason: NUM, is_awake: NUM, unlocking: NUM, shade: NUM,
      mem_normal: NUM, top_process_state: NUM_NULL, home_pid: NUM_NULL,
      heavy_weight_pid: NUM_NULL, previous_pid: NUM_NULL, dozing_ui_pid: NUM_NULL,
      idle_allowlist_appids: STR_NULL,
    });
    const out: Snapshot[] = [];
    for (; it.valid(); it.next()) {
      out.push({
        id: it.id, ts: BigInt(it.ts), reason: it.reason,
        isAwake: it.is_awake > 0, unlocking: it.unlocking > 0,
        shade: it.shade > 0, memNormal: it.mem_normal > 0,
        topProcState: it.top_process_state, homePid: it.home_pid,
        heavyPid: it.heavy_weight_pid, prevPid: it.previous_pid,
        dozingPid: it.dozing_ui_pid, idleAllowlist: it.idle_allowlist_appids ?? '',
      });
    }
    this.snapshots = out;
    // Honor a deep-linked snapshot id; otherwise default to the latest.
    const wanted =
      this.wantSnapshotId !== undefined
        ? out.findIndex((s) => s.id === this.wantSnapshotId)
        : -1;
    this.idx = wanted >= 0 ? wanted : Math.max(0, out.length - 1);
    await this.loadSnapshot();
  }

  private async loadSnapshot() {
    const snap = this.snapshots[this.idx];
    if (snap === undefined) return;
    const token = ++this.loadToken;
    const q = await this.trace.engine.query(`
      SELECT pid, process_name AS name, uid, cur_adj, adj_type,
             adj_source_pid, cur_proc_state, cur_sched_group, cur_capability,
             is_frozen, persistent, cached_adj
      FROM android_process_state_process
      WHERE snapshot_id = ${snap.id}
      ORDER BY cur_adj`);
    if (token !== this.loadToken) return;
    const rows: Row[] = [];
    const it = q.iter({});
    this.procCols = q.columns();
    for (; it.valid(); it.next()) {
      const r: Row = {};
      for (const c of this.procCols) r[c] = it.get(c);
      rows.push(r);
    }
    this.procRows = rows;
    this.procDs = new InMemoryDataSource(rows);

    // Mutation events (transitions: process/frozen/memory/uid/service/broadcast/
    // provider) captured between the previous snapshot and this one.
    const evQ = await this.trace.engine.query(`
      SELECT ts, kind, pid, uid, label, prev_adj, next_adj,
             prev_proc_state, next_proc_state, fg_service_types
      FROM android_process_state_mutation_event
      WHERE snapshot_id = ${snap.id}
      ORDER BY ts`);
    if (token !== this.loadToken) return;
    this.eventRows = this.rowsOf(evQ).map((r) => ({
      ts: r['ts'],
      event: KIND_NAME[Number(r['kind'])] ?? `kind ${r['kind']}`,
      pid: r['pid'],
      uid: r['uid'],
      detail: eventDetail(r),
    }));
    this.eventDs = new InMemoryDataSource(this.eventRows);

    await this.loadSelected();
    m.redraw();
  }

  private async loadSelected() {
    const snap = this.snapshots[this.idx];
    if (snap === undefined || this.selectedPid === undefined) {
      this.inRows = this.outRows = this.provOutRows = this.provInRows = [];
      this.whyRows = [];
      this.whyCompute = undefined;
      this.whyFromSnapId = undefined;
      this.hostedSvc = [];
      this.hostedProv = [];
      return;
    }
    const token = this.loadToken;
    const pid = this.selectedPid;
    // Outbound: services/providers THIS pid is a client of (who it depends on).
    const outQ = await this.trace.engine.query(`
      SELECT b.client_pid, b.service_id, s.short_name AS service,
             s.owning_pid AS server_pid, b.flag_foreground_service AS fg,
             b.flag_auto_create AS auto_create
      FROM android_process_state_binding b
      LEFT JOIN android_process_state_service s
        ON s.snapshot_id = b.snapshot_id AND s.service_id = b.service_id
      WHERE b.snapshot_id = ${snap.id} AND b.client_pid = ${pid}`);
    // Inbound: clients bound to services HOSTED by this pid (who depends on us).
    const inQ = await this.trace.engine.query(`
      SELECT b.client_pid, s.short_name AS service, b.flag_foreground_service AS fg
      FROM android_process_state_binding b
      JOIN android_process_state_service s
        ON s.snapshot_id = b.snapshot_id AND s.service_id = b.service_id
      WHERE b.snapshot_id = ${snap.id} AND s.owning_pid = ${pid}`);
    // Outbound content-provider deps: providers THIS pid is a client of.
    const provOutQ = await this.trace.engine.query(`
      SELECT pb.client_pid, p.authority, p.package_name AS pkg,
             p.owning_pid AS server_pid, pb.stable_count, pb.unstable_count,
             pb.dead, pb.waiting
      FROM android_process_state_provider_binding pb
      JOIN android_process_state_provider p
        ON p.snapshot_id = pb.snapshot_id AND p.provider_id = pb.provider_id
      WHERE pb.snapshot_id = ${snap.id} AND pb.client_pid = ${pid}`);
    // Inbound: clients of providers HOSTED by this pid.
    const provInQ = await this.trace.engine.query(`
      SELECT pb.client_pid, p.authority, pb.stable_count, pb.unstable_count
      FROM android_process_state_provider_binding pb
      JOIN android_process_state_provider p
        ON p.snapshot_id = pb.snapshot_id AND p.provider_id = pb.provider_id
      WHERE pb.snapshot_id = ${snap.id} AND p.owning_pid = ${pid}`);
    // The oom-adj "why-chain": the ordered conditions the OomAdjuster applied
    // to derive this process's adj. A process only has a compute in snapshots
    // where it was actually recomputed, so fall back to the most recent compute
    // at-or-before the current snapshot (by ts) and label where it came from.
    const compQ = await this.trace.engine.query(`
      SELECT c.id AS cid, c.snapshot_id AS csid,
             c.prev_adj, c.final_adj, c.prev_proc_state, c.final_proc_state,
             c.final_sched_group, c.duration_ns, c.oom_adj_reason
      FROM android_process_state_adj_compute c
      JOIN android_process_state_snapshot s ON s.id = c.snapshot_id
      WHERE c.pid = ${pid} AND s.ts <= ${snap.ts}
      ORDER BY s.ts DESC, c.compute_id DESC LIMIT 1`);
    const compRows = this.rowsOf(compQ);
    const comp0 = compRows.length ? compRows[0] : undefined;
    const cid = comp0 ? Number(comp0['cid']) : -1;
    const whyQ = await this.trace.engine.query(`
      SELECT s.step_index AS idx, s.note AS note, s.kind AS kind,
             s.source_pid AS source_pid, s.chain_depth AS chain_depth
      FROM android_process_state_adj_step s
      WHERE s.compute_id = ${cid}
      ORDER BY s.step_index`);
    if (token !== this.loadToken) return;
    this.outRows = this.rowsOf(outQ);
    this.inRows = this.rowsOf(inQ);
    this.provOutRows = this.rowsOf(provOutQ);
    this.provInRows = this.rowsOf(provInQ);
    this.whyRows = this.rowsOf(whyQ);
    this.whyCompute = comp0;
    this.whyFromSnapId = comp0 ? Number(comp0['csid']) : undefined;

    // Components this process hosts (its own services / providers).
    const hsvcQ = await this.trace.engine.query(`
      SELECT short_name AS service, foreground_service_type AS fgs,
             is_foreground AS fg, start_requested AS started
      FROM android_process_state_service
      WHERE snapshot_id = ${snap.id} AND owning_pid = ${pid}`);
    const hprovQ = await this.trace.engine.query(`
      SELECT authority, package_name AS pkg, external_handle_count AS ext
      FROM android_process_state_provider
      WHERE snapshot_id = ${snap.id} AND owning_pid = ${pid}`);
    this.hostedSvc = this.rowsOf(hsvcQ);
    this.hostedProv = this.rowsOf(hprovQ);

    this.buildDetailGrids(pid);
  }

  // Turn the selected process's facts into grid rows + cached data sources, so
  // every detail section is a sortable/filterable DataGrid.
  private buildDetailGrids(pid: number) {
    const p = this.procRows.find((r) => Number(r['pid']) === pid);
    const v = (k: string) =>
      !p || p[k] === null || p[k] === undefined ? '—' : String(p[k]);
    this.oomAdjRows = [
      {property: 'cur adj', value: `${v('cur_adj')} (${v('adj_type')})`},
      {property: 'proc state', value: v('cur_proc_state')},
      {property: 'sched group', value: v('cur_sched_group')},
      {property: 'capability', value: v('cur_capability')},
      {property: 'frozen', value: p && Number(p['is_frozen']) ? 'yes' : 'no'},
      {property: 'persistent', value: p && Number(p['persistent']) ? 'yes' : 'no'},
      {property: 'adj source', value: v('adj_source_pid')},
    ];
    this.chainRows = this.whyRows.map((s, i) => ({
      step: i + 1, reason: String(s['note'] ?? '?'),
      source_pid: Number(s['source_pid']) || '',
    }));
    this.hostedAll = [
      ...this.hostedSvc.map((s) => ({
        kind: 'service', name: String(s['service'] ?? ''),
        flags: Number(s['fg']) ? 'fgs' : (Number(s['started']) ? 'started' : ''),
      })),
      ...this.hostedProv.map((s) => ({
        kind: 'provider', name: String(s['authority'] ?? ''), flags: '',
      })),
    ];
    this.outAll = [
      ...this.outRows.map((b) => ({
        pid: Number(b['server_pid'] ?? 0), kind: 'service',
        name: String(b['service'] ?? ''), fg: Number(b['fg']) ? 'fg' : '',
      })),
      ...this.provOutRows.map((b) => ({
        pid: Number(b['server_pid'] ?? 0), kind: 'provider',
        name: String(b['authority'] ?? ''), fg: '',
      })),
    ];
    this.inAll = [
      ...this.inRows.map((b) => ({
        pid: Number(b['client_pid'] ?? 0), kind: 'service',
        name: String(b['service'] ?? ''), fg: Number(b['fg']) ? 'fg' : '',
      })),
      ...this.provInRows.map((b) => ({
        pid: Number(b['client_pid'] ?? 0), kind: 'provider',
        name: String(b['authority'] ?? ''), fg: '',
      })),
    ];
    this.oomAdjDs = new InMemoryDataSource(this.oomAdjRows);
    this.chainDs = new InMemoryDataSource(this.chainRows);
    this.hostedDs = new InMemoryDataSource(this.hostedAll);
    this.outDs = new InMemoryDataSource(this.outAll);
    this.inDs = new InMemoryDataSource(this.inAll);
  }

  private rowsOf(q: ReturnType<Trace['engine']['query']> extends Promise<infer R> ? R : never): Row[] {
    const cols = q.columns();
    const it = q.iter({});
    const rows: Row[] = [];
    for (; it.valid(); it.next()) {
      const r: Row = {};
      for (const c of cols) r[c] = it.get(c);
      rows.push(r);
    }
    return rows;
  }

  private seeking = false;

  private setIdx(i: number) {
    const clamped = Math.min(this.snapshots.length - 1, Math.max(0, i));
    if (clamped === this.idx) return;
    this.idx = clamped;
    this.loadSnapshot().catch((e) => console.error(e));
  }

  private step(d: number) {
    this.setIdx(this.idx + d);
  }

  // Map a fractional x (0..1) along the seek bar to the snapshot nearest in time.
  private seekTo(frac: number) {
    const n = this.snapshots.length;
    if (n === 0) return;
    const t0 = this.snapshots[0].ts;
    const t1 = this.snapshots[n - 1].ts;
    const target = t0 + BigInt(Math.round(Number(t1 - t0) * Math.min(1, Math.max(0, frac))));
    // nearest snapshot by ts
    let best = 0;
    let bestD = -1n;
    for (let i = 0; i < n; i++) {
      const d = this.snapshots[i].ts > target
        ? this.snapshots[i].ts - target : target - this.snapshots[i].ts;
      if (bestD < 0n || d < bestD) { bestD = d; best = i; }
    }
    this.setIdx(best);
  }

  private onSeek(ev: PointerEvent, down: boolean) {
    if (down) {
      this.seeking = true;
      (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    }
    if (!this.seeking) return;
    const rect = (ev.currentTarget as Element).getBoundingClientRect();
    this.seekTo((ev.clientX - rect.left) / rect.width);
  }

  private select(pid: number) {
    this.selectedPid = pid;
    this.selectedEdge = undefined;
    this.tab = 'detail';
    this.loadSelected().then(() => m.redraw()).catch((e) => console.error(e));
  }

  private selectEdge(e: EdgeSel) {
    this.selectedEdge = e;
    this.tab = 'detail';
    m.redraw();
  }

  private nameOf(pid: number): string {
    const r = this.procRows.find((p) => Number(p['pid']) === pid);
    return r ? String(r['name'] ?? pid).replace(/^.*\//, '') : String(pid);
  }

  private tabBtn(id: 'procs' | 'detail' | 'events', label: string): m.Children {
    return m(
      'button.pf-ps-tab' + (this.tab === id ? '.pf-ps-tab--on' : ''),
      {onclick: () => { this.tab = id; }},
      label,
    );
  }

  view() {
    if (this.snapshots.length === 0) {
      return m('.pf-ps-page', m('.pf-ps-empty', 'Loading process-state snapshots…'));
    }
    const snap = this.snapshots[this.idx];
    const hasSel = this.selectedPid !== undefined || this.selectedEdge !== undefined;
    return m('.pf-ps-page', [
      this.renderSeek(snap),
      this.procDs &&
        m('.pf-ps-graphwrap',
          m(ProcessGraph, {
            processes: this.procRows,
            bindingsQuery: snap.id,
            trace: this.trace,
            selectedPid: this.selectedPid,
            onSelect: (pid) => this.select(pid),
            onEdgeSelect: (e) => this.selectEdge(e),
          })),
      m('.pf-ps-bottom', [
        m('.pf-ps-tabs', [
          this.tabBtn('procs', `Processes · ${this.procRows.length}`),
          hasSel
            ? this.tabBtn('detail',
                this.selectedEdge ? '▸ binding' : `▸ pid ${this.selectedPid}`)
            : null,
          this.tabBtn('events', `Events · ${this.eventRows.length}`),
        ]),
        m('.pf-ps-tabbody' + (this.tab === 'detail' ? '.pf-ps-tabbody--scroll' : ''),
          this.tabBody()),
      ]),
    ]);
  }

  // Winscope-style seek bar: scrub across the snapshots over time. A tick per
  // snapshot, a draggable playhead, and the device-wide context of the snapshot
  // you're on — so navigating time and reading state happen in one place.
  private renderSeek(snap: Snapshot): m.Children {
    const n = this.snapshots.length;
    const t0 = this.snapshots[0].ts;
    const span = Number(this.snapshots[n - 1].ts - t0) || 1;
    const pct = (s: Snapshot) => (Number(s.ts - t0) / span) * 100;
    return m('.pf-ps-seekwrap', [
      m('.pf-ps-seekrow', [
        m('button.pf-ps-step', {onclick: () => this.step(-1)}, '‹'),
        m('.pf-ps-seek', {
          onpointerdown: (e: PointerEvent) => this.onSeek(e, true),
          onpointermove: (e: PointerEvent) => this.onSeek(e, false),
          onpointerup: () => { this.seeking = false; },
          onpointerleave: () => { this.seeking = false; },
        }, [
          m('.pf-ps-seek-line'),
          ...this.snapshots.map((s, i) =>
            m('.pf-ps-seek-tick' + (i === this.idx ? '.pf-ps-seek-tick--on' : ''),
              {style: `left:${pct(s)}%`})),
          m('.pf-ps-seek-head', {style: `left:${pct(snap)}%`}),
        ]),
        m('button.pf-ps-step', {onclick: () => this.step(1)}, '›'),
        m('span.pf-ps-pos',
          `${this.idx + 1}/${n} · reason ${snap.reason} · ${this.procRows.length} procs`),
      ]),
      m('.pf-ps-dev', this.deviceState(snap)),
    ]);
  }

  // Compact device-wide context for the current snapshot (clickable role pids).
  private deviceState(snap: Snapshot): m.Children {
    return [
      m('span.pf-ps-chip', snap.isAwake ? '● awake' : '○ asleep'),
      m('span.pf-ps-chip', `top-state ${snap.topProcState ?? '—'}`),
      m('span.pf-ps-chip' + (snap.memNormal ? '' : '.pf-ps-chip--warn'),
        snap.memNormal ? 'mem ok' : 'mem LOW'),
      snap.unlocking ? m('span.pf-ps-chip', 'unlocking') : null,
      snap.shade ? m('span.pf-ps-chip', 'shade') : null,
      this.devChip('home', snap.homePid),
      this.devChip('heavy', snap.heavyPid),
      this.devChip('prev', snap.prevPid),
      this.devChip('dozing-ui', snap.dozingPid),
      snap.idleAllowlist
        ? m('span.pf-ps-chip', `idle-allowlist ${snap.idleAllowlist.split(',').length}`)
        : null,
    ];
  }

  private devChip(label: string, pid: number | null): m.Children {
    if (pid === null || pid === undefined) return null;
    return m('span.pf-ps-chip.pf-ps-chip--link',
      {onclick: () => this.select(pid)}, `${label} ${pid}`);
  }

  private tabBody(): m.Children {
    if (this.tab === 'events') {
      return this.eventDs && this.eventRows.length
        ? m(DataGrid, {
            schema: gridSchema(EVENT_COLS, (pid) => this.select(pid)),
            rootSchema: 'root', data: this.eventDs, fillHeight: true,
            initialColumns: EVENT_COLS.map((c) => ({id: c, field: c})),
          })
        : m('.pf-ps-none', '— no transitions captured in this window —');
    }
    if (this.tab === 'detail') return this.renderDetail();
    return this.procDs
      ? m(DataGrid, {
          schema: gridSchema(this.procCols, (pid) => this.select(pid)),
          rootSchema: 'root', data: this.procDs, fillHeight: true,
          initialColumns: this.procCols.map((c) => ({id: c, field: c})),
        })
      : m('.pf-ps-none', 'Loading…');
  }

  // ----- structured detail panel: a clicked edge OR a selected process -----

  private renderDetail(): m.Children {
    if (this.selectedEdge) return this.renderEdgeDetail(this.selectedEdge);
    if (this.selectedPid !== undefined) return this.renderProcessDetail(this.selectedPid);
    return m('.pf-ps-none',
      'Click a node or an edge in the graph (or a row in Processes) to inspect it.');
  }

  private gridCard(title: string, cols: string[], rows: Row[],
      ds?: InMemoryDataSource): m.Children {
    return gridCard(title, cols, rows, ds, (pid) => this.select(pid));
  }

  private renderProcessDetail(pid: number): m.Children {
    const p = this.procRows.find((r) => Number(r['pid']) === pid);
    if (!p) return m('.pf-ps-none', `pid ${pid} not present in this snapshot.`);
    const c = this.whyCompute;
    const fromIdx = this.snapshots.findIndex((s) => s.id === this.whyFromSnapId);
    const chainTitle = c
      ? `derivation chain \u00b7 adj ${c['prev_adj']}\u2192${c['final_adj']} \u00b7 reason `
        + `${c['oom_adj_reason']}`
        + (fromIdx >= 0 && fromIdx !== this.idx ? ` \u00b7 from snap ${fromIdx + 1}` : '')
      : 'derivation chain';
    return m('.pf-ps-detailpane', [
      m('.pf-ps-detail-h', [
        m('span.pf-ps-detail-title', this.nameOf(pid)),
        m('span.pf-ps-detail-sub', `pid ${pid} \u00b7 uid ${p['uid']}`),
      ]),
      m('.pf-ps-cards', [
        m('.pf-ps-col', [
          this.gridCard('oom-adj', ['property', 'value'], this.oomAdjRows, this.oomAdjDs),
          this.gridCard(chainTitle,
            ['step', 'reason', 'source_pid'], this.chainRows, this.chainDs),
          this.gridCard('hosts (components)',
            ['kind', 'name', 'flags'], this.hostedAll, this.hostedDs),
        ]),
        m('.pf-ps-col', [
          this.gridCard('depends on \u2014 outbound',
            ['pid', 'kind', 'name', 'fg'], this.outAll, this.outDs),
          this.gridCard('depended on by \u2014 inbound',
            ['pid', 'kind', 'name', 'fg'], this.inAll, this.inDs),
        ]),
      ]),
    ]);
  }

  private renderEdgeDetail(e: EdgeSel): m.Children {
    const nameCol = e.kind === 'provider' ? 'authority' : 'service';
    const names = (e.names ? e.names.split(',') : []).map((n) => ({[nameCol]: n}));
    const edgeRow = [{
      client_pid: e.from, host_pid: e.to, connections: e.count,
      foreground: e.fg ? 'yes' : 'no',
    }];
    return m('.pf-ps-detailpane', m('.pf-ps-cards', [
      m('.pf-ps-col', this.gridCard(
        e.kind === 'provider' ? 'content-provider binding' : 'service binding',
        ['client_pid', 'host_pid', 'connections', 'foreground'],
        edgeRow, new InMemoryDataSource(edgeRow))),
      m('.pf-ps-col', this.gridCard(
        e.kind === 'provider' ? 'authorities' : 'services',
        [nameCol], names, new InMemoryDataSource(names))),
    ]));
  }
}
