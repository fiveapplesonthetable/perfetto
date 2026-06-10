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
import type {Trace} from '../../public/trace';
import type {Row} from '../../trace_processor/query_result';
import {NUM, NUM_NULL} from '../../trace_processor/query_result';
import type {TrackEventDetailsPanel} from '../../public/details_panel';
import type {TrackEventSelection} from '../../public/selection';
import {Button} from '../../widgets/button';
import {Intent} from '../../widgets/common';
import {DetailsShell} from '../../widgets/details_shell';
import {ProcessGraph} from './process_graph';
import type {EdgeSel} from './process_graph';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import {gridCard} from './grid_helpers';

// Details panel shown when a snapshot slice on the "Process state" timeline
// track is selected. Renders the same interactive process-relationship graph as
// the full-page explorer (so you can peek the wiring inline), plus a button to
// jump to the full explorer at this exact snapshot for the grids + drill-down.
export class ProcessStateDetailsPanel implements TrackEventDetailsPanel {
  private readonly trace: Trace;
  private snapshotId?: number;
  private processes: Row[] = [];
  private reason = 0;
  private selectedPid?: number;
  private selectedEdge?: EdgeSel;
  private devLine = '';
  private eventCount = 0;
  private nodeRows: Row[] = [];
  private nodeDs?: InMemoryDataSource;
  private edgeRows: Row[] = [];
  private edgeDs?: InMemoryDataSource;
  private edgeNames: Row[] = [];
  private edgeNamesDs?: InMemoryDataSource;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  async load(sel: TrackEventSelection) {
    // sel.eventId is the slice id, which the track's dataset maps directly to
    // android_process_state_snapshot.id.
    this.snapshotId = sel.eventId;
    this.selectedPid = undefined;
    this.selectedEdge = undefined;
    const meta = await this.trace.engine.query(`
      SELECT oom_adj_reason AS reason, is_awake, top_process_state AS tps,
             last_memory_level_normal AS mem, unlocking, expanded_notification_shade AS shade,
             home_pid, heavy_weight_pid AS heavy, previous_pid AS prev, dozing_ui_pid AS dozing,
             (SELECT count(*) FROM android_process_state_mutation_event e
                WHERE e.snapshot_id = s.id) AS nevents
      FROM android_process_state_snapshot s WHERE s.id = ${sel.eventId}`);
    const mit = meta.iter({
      reason: NUM, is_awake: NUM, tps: NUM_NULL, mem: NUM, unlocking: NUM, shade: NUM,
      home_pid: NUM_NULL, heavy: NUM_NULL, prev: NUM_NULL, dozing: NUM_NULL, nevents: NUM,
    });
    if (mit.valid()) {
      this.reason = mit.reason;
      this.eventCount = mit.nevents;
      const pid = (label: string, v: number | null) =>
        v !== null ? ` · ${label}=${v}` : '';
      this.devLine =
        (mit.is_awake ? '● awake' : '○ asleep') +
        ` · top proc-state ${mit.tps ?? '—'}` +
        (mit.mem ? ' · mem normal' : ' · mem LOW') +
        (mit.unlocking ? ' · unlocking' : '') +
        (mit.shade ? ' · shade expanded' : '') +
        pid('home', mit.home_pid) + pid('heavy', mit.heavy) +
        pid('prev', mit.prev) + pid('dozing-ui', mit.dozing);
    } else {
      this.reason = 0;
      this.devLine = '';
      this.eventCount = 0;
    }
    // Same projection the full page uses, so the graph is identical.
    const q = await this.trace.engine.query(`
      SELECT pid, process_name AS name, uid, cur_adj, adj_type,
             adj_source_pid, cur_proc_state, cur_sched_group, cur_capability,
             is_frozen, persistent, cached_adj
      FROM android_process_state_process
      WHERE snapshot_id = ${sel.eventId}
      ORDER BY cur_adj`);
    const cols = q.columns();
    const it = q.iter({});
    const rows: Row[] = [];
    for (; it.valid(); it.next()) {
      const r: Row = {};
      for (const c of cols) r[c] = it.get(c);
      rows.push(r);
    }
    this.processes = rows;
  }

  render() {
    if (this.snapshotId === undefined) {
      return m(DetailsShell, {title: 'Process state'}, m('span', 'Loading…'));
    }
    const id = this.snapshotId;
    return m(
      DetailsShell,
      {
        title: 'Process state snapshot',
        description:
          `${this.processes.length} processes · oom_adj_reason ${this.reason}`
          + ` · ${this.eventCount} mutation event${this.eventCount === 1 ? '' : 's'}`,
        buttons: m(Button, {
          label: 'Open full explorer ↗',
          intent: Intent.Primary,
          onclick: () => {
            // Deep-link the explorer page to this snapshot id (parsed by
            // ProcessStatePage from its subpage).
            this.trace.navigate(`#!/process_state/${id}`);
          },
        }),
        className: 'pf-ps-detailpanel',
      },
      m('.pf-ps-devstate', this.devLine),
      m('.pf-ps-panelsplit', [
        m('.pf-ps-detailgraph',
          m(ProcessGraph, {
            trace: this.trace,
            processes: this.processes,
            bindingsQuery: id,
            selectedPid: this.selectedPid,
            onSelect: (pid: number) => {
              this.selectedPid = pid; this.selectedEdge = undefined;
              this.buildNode(pid); m.redraw();
            },
            onEdgeSelect: (e) => {
              this.selectedEdge = e; this.buildEdge(e); m.redraw();
            },
          })),
        m('.pf-ps-panelprops', this.renderProps()),
      ]),
    );
  }

  private nameOf(pid: number): string {
    const r = this.processes.find((p) => Number(p['pid']) === pid);
    return r ? String(r['name'] ?? pid).replace(/^.*\//, '') : String(pid);
  }

  private buildNode(pid: number) {
    const p = this.processes.find((r) => Number(r['pid']) === pid);
    const v = (k: string) =>
      !p || p[k] === null || p[k] === undefined ? '—' : String(p[k]);
    this.nodeRows = [
      {property: 'cur adj', value: `${v('cur_adj')} (${v('adj_type')})`},
      {property: 'proc state', value: v('cur_proc_state')},
      {property: 'sched group', value: v('cur_sched_group')},
      {property: 'capability', value: v('cur_capability')},
      {property: 'frozen', value: p && Number(p['is_frozen']) ? 'yes' : 'no'},
      {property: 'adj source', value: v('adj_source_pid')},
    ];
    this.nodeDs = new InMemoryDataSource(this.nodeRows);
  }

  private buildEdge(e: EdgeSel) {
    this.edgeRows = [{
      client_pid: e.from, host_pid: e.to, connections: e.count,
      foreground: e.fg ? 'yes' : 'no',
    }];
    const col = e.kind === 'provider' ? 'authority' : 'service';
    this.edgeNames = (e.names ? e.names.split(',') : []).map((n) => ({[col]: n}));
    this.edgeDs = new InMemoryDataSource(this.edgeRows);
    this.edgeNamesDs = new InMemoryDataSource(this.edgeNames);
  }

  private renderProps(): m.Children {
    const onPid = () => {}; // panel rows aren't navigation targets
    if (this.selectedEdge) {
      const e = this.selectedEdge;
      const nameCol = e.kind === 'provider' ? 'authority' : 'service';
      return m('.pf-ps-detailpane', [
        gridCard(e.kind === 'provider' ? 'content-provider binding' : 'service binding',
          ['client_pid', 'host_pid', 'connections', 'foreground'],
          this.edgeRows, this.edgeDs, onPid),
        gridCard(e.kind === 'provider' ? 'authorities' : 'services',
          [nameCol], this.edgeNames, this.edgeNamesDs, onPid),
      ]);
    }
    if (this.selectedPid !== undefined) {
      return m('.pf-ps-detailpane', [
        m('.pf-ps-detail-h', [
          m('span.pf-ps-detail-title', this.nameOf(this.selectedPid)),
          m('span.pf-ps-detail-sub', `pid ${this.selectedPid}`),
        ]),
        gridCard('oom-adj', ['property', 'value'], this.nodeRows, this.nodeDs, onPid),
        m('.pf-ps-none', 'Open the full explorer for the why-chain & bindings.'),
      ]);
    }
    return m('.pf-ps-none', 'Click a node or an edge for details.');
  }
}
