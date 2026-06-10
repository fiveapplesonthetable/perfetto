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
import {NUM, STR_NULL} from '../../trace_processor/query_result';

export interface EdgeSel {
  readonly from: number;
  readonly to: number;
  readonly kind: 'service' | 'provider';
  readonly count: number;
  readonly names: string;
  readonly fg: boolean;
}

export interface ProcessGraphAttrs {
  readonly trace: Trace;
  readonly processes: ReadonlyArray<Row>;
  readonly bindingsQuery: number; // snapshot id
  readonly selectedPid?: number;
  readonly onSelect: (pid: number) => void;
  // Clicking an edge reports the binding up so the host can show its details.
  readonly onEdgeSelect?: (e: EdgeSel) => void;
}

interface Edge {
  readonly from: number; // client pid
  readonly to: number; // server pid
  readonly fg: boolean;
  readonly kind: 'service' | 'provider';
  readonly count: number; // number of underlying bindings
  readonly names: string; // service short-names / provider authorities
}

// Map an oom-adj value to a tier index (column) and colour, so the graph is
// laid out left-to-right by importance (lower adj = more important = left).
function tier(adj: number): number {
  if (adj < 0) return 0; // persistent / system
  if (adj <= 100) return 1; // foreground / visible
  if (adj <= 200) return 2; // perceptible
  if (adj <= 250) return 3; // service
  if (adj < 900) return 4; // background / cached-ish
  return 5; // cached empty
}
const TIER_LABEL = ['persist', 'fg/vis', 'percept', 'service', 'bg', 'cached'];
// Tableau 10 categorical palette — muted, even-weight colours.
const TIER_COLOR = [
  '#e15759', // persist  — red
  '#59a14f', // fg/vis   — green
  '#4e79a7', // percept  — blue
  '#b07aa1', // service  — purple
  '#f28e2b', // bg       — orange
  '#bab0ac', // cached   — grey
];
const EDGE_SERVICE = '#bab0ac';
const EDGE_PROVIDER = '#4e79a7';
const EDGE_FG = '#e15759';

// A hand-rolled, deterministic SVG node-graph: processes are nodes laid out in
// columns by oom-adj tier; service/content-provider bindings are directed
// edges (client -> server). Clicking a node selects it and drives the grids.
// Deterministic layout (vs a force sim) so positions stay stable while you
// scrub snapshots.
export class ProcessGraph implements m.ClassComponent<ProcessGraphAttrs> {
  private edges: Edge[] = [];
  private loadedFor = -1;
  private hoverPid?: number;
  // The edge the user clicked: highlighted + its bindings kept on screen.
  private selectedEdge?: {from: number; to: number};
  // oom-adj importance columns. (The adj-source 'tree' layout exists but the
  // toggle was removed to keep the surface focused.)
  private mode: 'tiers' | 'tree' = 'tiers';
  // viewBox for zoom/pan. While userAdjusted is false the graph auto-fits to
  // content on every render (so scrubbing snapshots reframes to fit); once the
  // user zooms or pans we preserve their viewport. Fit resets userAdjusted.
  private vb?: {x: number; y: number; w: number; h: number};
  private userAdjusted = false;
  private vw = 0; // svg viewport px (for aspect-matched fit)
  private vh = 0;
  private cw = 0; // content bounds (for pan clamping)
  private ch = 0;
  // Pending pointer-down (not yet a drag) + whether we've crossed the drag
  // threshold. We only capture the pointer once a real drag starts, so plain
  // clicks still reach nodes/edges.
  private down?: {px: number; py: number; vx: number; vy: number; id: number; el: Element};
  private dragging = false;

  private onWheel(ev: WheelEvent) {
    if (!this.vb) return;
    this.userAdjusted = true;
    ev.preventDefault();
    const svg = ev.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    const fy = (ev.clientY - rect.top) / rect.height;
    const k = ev.deltaY > 0 ? 1.12 : 1 / 1.12; // wheel down = zoom out
    const nw = Math.max(60, Math.min(this.vb.w * 8, this.vb.w * k));
    const nh = this.vb.h * (nw / this.vb.w);
    // keep the point under the cursor fixed
    this.vb = {
      x: this.vb.x + (this.vb.w - nw) * fx,
      y: this.vb.y + (this.vb.h - nh) * fy,
      w: nw, h: nh,
    };
  }
  private onDown(ev: PointerEvent) {
    if (!this.vb) return;
    // Record the start but DON'T capture yet — capturing here would steal the
    // click from nodes/edges. We promote to a drag only once the pointer moves.
    this.down = {
      px: ev.clientX, py: ev.clientY, vx: this.vb.x, vy: this.vb.y,
      id: ev.pointerId, el: ev.currentTarget as Element,
    };
    this.dragging = false;
  }
  private onMove(ev: PointerEvent) {
    if (!this.down || !this.vb) return;
    const dx = ev.clientX - this.down.px;
    const dy = ev.clientY - this.down.py;
    if (!this.dragging) {
      if (Math.hypot(dx, dy) < 4) return; // still a click, not a drag
      this.dragging = true;
      this.userAdjusted = true;
      this.down.el.setPointerCapture(this.down.id);
    }
    const rect = (ev.currentTarget as Element).getBoundingClientRect();
    let nx = this.down.vx - dx / rect.width * this.vb.w;
    let ny = this.down.vy - dy / rect.height * this.vb.h;
    // Clamp so at least a margin of content stays on screen (can't lose it).
    const M = 60;
    nx = Math.max(-this.vb.w + M, Math.min(this.cw - M, nx));
    ny = Math.max(-this.vb.h + M, Math.min(this.ch - M, ny));
    this.vb.x = nx;
    this.vb.y = ny;
  }
  private onUp() { this.down = undefined; this.dragging = false; }

  private async load(attrs: ProcessGraphAttrs) {
    const snap = attrs.bindingsQuery;
    const q = await attrs.trace.engine.query(`
      SELECT b.client_pid AS f, s.owning_pid AS t,
             max(b.flag_foreground_service) AS fg, count(*) AS cnt,
             group_concat(DISTINCT s.short_name) AS names
      FROM android_process_state_binding b
      JOIN android_process_state_service s
        ON s.snapshot_id = b.snapshot_id AND s.service_id = b.service_id
      WHERE b.snapshot_id = ${snap} AND b.client_pid != s.owning_pid
      GROUP BY b.client_pid, s.owning_pid`);
    const it = q.iter({f: NUM, t: NUM, fg: NUM, cnt: NUM, names: STR_NULL});
    const edges: Edge[] = [];
    for (; it.valid(); it.next()) {
      edges.push({from: it.f, to: it.t, fg: it.fg > 0, kind: 'service',
        count: it.cnt, names: it.names ?? ''});
    }
    // Content-provider edges: client -> provider-owning process.
    const pq = await attrs.trace.engine.query(`
      SELECT pb.client_pid AS f, p.owning_pid AS t, count(*) AS cnt,
             group_concat(DISTINCT p.authority) AS names
      FROM android_process_state_provider_binding pb
      JOIN android_process_state_provider p
        ON p.snapshot_id = pb.snapshot_id AND p.provider_id = pb.provider_id
      WHERE pb.snapshot_id = ${snap} AND pb.client_pid != p.owning_pid
      GROUP BY pb.client_pid, p.owning_pid`);
    const pit = pq.iter({f: NUM, t: NUM, cnt: NUM, names: STR_NULL});
    for (; pit.valid(); pit.next()) {
      edges.push({from: pit.f, to: pit.t, fg: false, kind: 'provider',
        count: pit.cnt, names: pit.names ?? ''});
    }
    this.edges = edges;
    this.loadedFor = snap;
    m.redraw();
  }

  view({attrs}: m.Vnode<ProcessGraphAttrs>) {
    if (this.loadedFor !== attrs.bindingsQuery) {
      this.load(attrs).catch((e) => console.error('ProcessGraph', e));
    }

    // Two layouts share the same node-rendering / zoom-pan machinery:
    //  * tiers: oom-adj importance columns (left = more important).
    //  * tree:  nest each process under its adj_source_pid — the "alive because
    //           of" hierarchy; killing a node implicates its whole subtree.
    const colW = 250; // column pitch (tiers) / label gutter (tree)
    const labelDx = 9; // label starts this far right of the node
    const rowH = 26;
    const top = 34;
    const left = 24;
    const r = 5;
    const indent = 30; // per-depth indent (tree)
    const nameOf = (p: Row) => String(p['name'] ?? p['pid']);
    const adjOfRow = (p: Row) => Number(p['cur_adj'] ?? 999);

    const pos = new Map<number, {x: number; y: number; adj: number; name: string}>();
    // Parent -> child edges (parent raises the child's adj) used only in tree mode.
    const treeEdges: Array<{from: number; to: number}> = [];
    let width = 0;
    let height = 0;

    if (this.mode === 'tree') {
      const byPid = new Map<number, Row>();
      for (const p of attrs.processes) byPid.set(Number(p['pid']), p);
      const children = new Map<number, number[]>();
      const hasParent = new Set<number>();
      for (const p of attrs.processes) {
        const pid = Number(p['pid']);
        const src = Number(p['adj_source_pid'] ?? 0);
        if (src && src !== pid && byPid.has(src)) {
          if (!children.has(src)) children.set(src, []);
          children.get(src)!.push(pid);
          hasParent.add(pid);
          treeEdges.push({from: src, to: pid});
        }
      }
      const adjOf = (pid: number) => adjOfRow(byPid.get(pid)!);
      const byImportance = (a: number, b: number) => adjOf(a) - adjOf(b) || a - b;
      // Subtree-bearing roots first (the interesting "keeps-alive" trees), then
      // lone processes; each ordered by importance.
      const roots = [...byPid.keys()]
        .filter((p) => !hasParent.has(p))
        .sort(
          (a, b) =>
            (children.has(b) ? 1 : 0) - (children.has(a) ? 1 : 0) ||
            byImportance(a, b),
        );
      let rowI = 0;
      let maxDepth = 0;
      const visit = (pid: number, depth: number) => {
        maxDepth = Math.max(maxDepth, depth);
        pos.set(pid, {
          x: left + depth * indent,
          y: top + rowI * rowH,
          adj: adjOf(pid),
          name: nameOf(byPid.get(pid)!),
        });
        rowI++;
        for (const k of (children.get(pid) ?? []).sort(byImportance)) {
          visit(k, depth + 1);
        }
      };
      for (const rt of roots) visit(rt, 0);
      height = top + 10 + Math.max(rowI, 1) * rowH;
      width = left + maxDepth * indent + colW; // room for the deepest label
    } else {
      const cols: number[][] = [[], [], [], [], [], []];
      for (const p of attrs.processes) {
        const pid = Number(p['pid']);
        const adj = adjOfRow(p);
        const t = tier(adj);
        const row = cols[t].length;
        cols[t].push(pid);
        pos.set(pid, {x: left + t * colW, y: top + row * rowH, adj, name: nameOf(p)});
      }
      height = top + 10 + Math.max(...cols.map((c) => c.length), 1) * rowH;
      width = left + 6 * colW;
    }

    // The "big picture" at rest: size each node by how many bindings touch it,
    // so hubs (system_server, etc.) read as big dots the moment the graph opens
    // — the overall shape is visible WITHOUT drawing any edges (which would
    // re-clutter the labels). Connection count = in + out edges.
    const degree = new Map<number, number>();
    for (const e of this.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const radiusOf = (pid: number) =>
      r + Math.min(8, Math.sqrt(degree.get(pid) ?? 0) * 1.7);

    // Edges are HIDDEN by default (so labels are never crossed) and revealed
    // only for the focused node — the one you hover, or the selected one. A
    // hover is a light, transient preview; a click selects and draws the same
    // edges BOLD and persistent (they stay after the pointer leaves). This
    // turns the graph into a "point to peek, click to pin" tool.
    // A clicked edge persists its node's edges (focus falls back to the edge's
    // client end), so the wiring stays on screen after the pointer leaves.
    const focus = this.hoverPid ?? attrs.selectedPid ?? this.selectedEdge?.from;
    // Bold when the shown edges belong to the selected (clicked) node: either
    // nothing is hovered (so focus == selection) or we're hovering it directly.
    const bold = this.hoverPid === undefined || this.hoverPid === attrs.selectedPid;
    const neighbours = new Set<number>();
    const edgeEls: m.Children[] = [];

    if (this.mode === 'tree') {
      // The parent->child edges ARE the structure, so draw them all (faint);
      // bold the ones touching the focused node (its parent + direct children).
      for (const e of treeEdges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const on = focus !== undefined && (e.from === focus || e.to === focus);
        if (on) { neighbours.add(e.from); neighbours.add(e.to); }
        const ax = a.x + radiusOf(e.from), bx = b.x - radiusOf(e.to);
        const d = `M ${ax} ${a.y} C ${ax + 16} ${a.y}, ${bx - 16} ${b.y}, ${bx} ${b.y}`;
        const isSel = this.selectedEdge?.from === e.from
          && this.selectedEdge?.to === e.to;
        edgeEls.push(m('g.pf-ps-edge', {
          onclick: () => { this.selectedEdge = {from: e.from, to: e.to}; },
        }, [
          m('path', {d, fill: 'none', stroke: 'transparent', 'stroke-width': 12}),
          m('path', {
            d, fill: 'none',
            stroke: isSel ? '#111' : EDGE_SERVICE,
            'stroke-opacity': isSel ? 1 : focus === undefined ? 0.4 : on ? 0.95 : 0.07,
            'stroke-width': isSel ? 3.6 : on ? 2.2 : 1,
            'marker-end': 'url(#pf-ps-arrow)',
          }),
        ]));
      }
    } else if (focus !== undefined) {
      // Edges HIDDEN by default (so labels are never crossed); revealed only for
      // the focused node — hover = light preview, click = pinned bold.
      for (const e of this.edges) {
        if (e.from !== focus && e.to !== focus) continue;
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        neighbours.add(e.from);
        neighbours.add(e.to);
        const base =
          e.kind === 'provider' ? EDGE_PROVIDER : e.fg ? EDGE_FG : EDGE_SERVICE;
        const ax = a.x + radiusOf(e.from), bx = b.x - radiusOf(e.to);
        const mx = (ax + bx) / 2;
        const d = `M ${ax} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${bx} ${b.y}`;
        const isSel = this.selectedEdge?.from === e.from
          && this.selectedEdge?.to === e.to;
        edgeEls.push(m('g.pf-ps-edge', {
          onclick: () => {
            this.selectedEdge = {from: e.from, to: e.to};
            attrs.onEdgeSelect?.({
              from: e.from, to: e.to, kind: e.kind, count: e.count,
              names: e.names, fg: e.fg,
            });
          },
        }, [
          // fat transparent hit area so a thin curve is easy to click
          m('path', {d, fill: 'none', stroke: 'transparent', 'stroke-width': 8}),
          m('path', {
            d, fill: 'none',
            stroke: isSel ? '#111' : base,
            'stroke-opacity': isSel ? 1 : bold ? 0.95 : 0.5,
            'stroke-width': isSel ? 3.6 : bold ? 2.4 : 1.3,
            'stroke-dasharray': e.kind === 'provider' ? '5,3' : undefined,
            'marker-end': 'url(#pf-ps-arrow)',
          }),
        ]));
      }
    }

    const nodeEls: m.Children[] = [];
    for (const [pid, p] of pos) {
      const sel = attrs.selectedPid === pid;
      // When a node is focused, dim everything that isn't it or a neighbour.
      const dim = focus !== undefined && pid !== focus && !neighbours.has(pid);
      const label = `${p.name.replace(/^.*\//, '').slice(0, 22)} ${pid}`;
      const nodeR = radiusOf(pid);
      nodeEls.push(
        m('g.pf-ps-node', {
          onclick: () => attrs.onSelect(pid),
          onmouseenter: () => { this.hoverPid = pid; },
          onmouseleave: () => {
            // Keep the focus (and its edges) while panning — the pointer
            // naturally leaves the node during a drag.
            if (this.hoverPid === pid && !this.dragging) this.hoverPid = undefined;
          },
          style: dim ? 'opacity:0.25' : undefined,
        }, [
          m('circle', {
            cx: p.x, cy: p.y, r: sel ? nodeR + 2 : nodeR,
            fill: TIER_COLOR[tier(p.adj)],
            stroke: sel ? '#222' : '#fff',
            'stroke-width': sel ? 2 : 0.6,
          }),
          // White halo (paint-order: stroke) keeps the label legible.
          m('text.pf-ps-nlabel', {
            x: p.x + nodeR + labelDx, y: p.y + 3,
            'font-size': 10, 'font-weight': sel || pid === focus ? 'bold' : 'normal',
          }, label),
        ]),
      );
    }

    const headers =
      this.mode === 'tiers'
        ? TIER_LABEL.map((l, i) =>
            m('text.pf-ps-col',
              {x: left + i * colW, y: 18, 'font-size': 11, 'font-weight': 'bold'}, l))
        : [m('text.pf-ps-col',
            {x: left, y: 18, 'font-size': 11, 'font-weight': 'bold'},
            'alive-because-of tree — each row is nested under the process keeping it alive')];

    // Auto-fit to content until the user manually zooms/pans (see userAdjusted).
    if (!this.userAdjusted || this.vb === undefined) {
      // Fit to content, but expand the viewBox to the viewport's aspect ratio so
      // there's no dead letterbox whitespace (and panning stays meaningful).
      let w = width;
      let h = height;
      if (this.vw > 0 && this.vh > 0) {
        const ar = this.vw / this.vh;
        if (w / h < ar) w = h * ar; else h = w / ar;
      }
      this.vb = {x: -(w - width) / 2, y: -(h - height) / 2, w, h};
    }
    this.cw = width;
    this.ch = height;
    const vb = this.vb;

    return m('.pf-ps-graph', [
      m('.pf-ps-legend', [
        m('span.pf-ps-hint', 'click a node or edge for details · hover to peek · scroll = zoom · drag = pan'),
        m('span.pf-ps-grow'),
        m('span.sv', '── service'),
        m('span.pv', '╌╌ provider'),
        m('button.pf-ps-fit', {onclick: () => { this.userAdjusted = false; }}, 'Fit'),
      ]),
      m('svg.pf-ps-svg', {
        width: '100%', height: '100%',
        viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`,
        preserveAspectRatio: 'xMidYMid meet',
        oncreate: (v: m.VnodeDOM) => {
          const r = (v.dom as Element).getBoundingClientRect();
          this.vw = r.width; this.vh = r.height;
        },
        onupdate: (v: m.VnodeDOM) => {
          const r = (v.dom as Element).getBoundingClientRect();
          if (r.width > 0) { this.vw = r.width; this.vh = r.height; }
        },
        onwheel: (e: WheelEvent) => this.onWheel(e),
        onpointerdown: (e: PointerEvent) => this.onDown(e),
        onpointermove: (e: PointerEvent) => this.onMove(e),
        onpointerup: () => this.onUp(),
        onpointerleave: () => this.onUp(),
      }, [
        m('defs',
          m('marker', {
            id: 'pf-ps-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
            markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
          }, m('path', {d: 'M 0 0 L 10 5 L 0 10 z', fill: '#90909088'}))),
        headers, edgeEls, nodeEls,
      ]),
    ]);
  }
}
