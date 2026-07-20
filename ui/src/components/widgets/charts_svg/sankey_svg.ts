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
import {classNames} from '../../../base/classnames';
import {shortUuid} from '../../../base/uuid';
import type {
  SankeyChartAttrs,
  SankeyData,
  SankeyLink,
  SankeyNode,
} from '../charts/sankey';
import {chartColorVar, defaultFmt} from './common';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {
  SankeyChartAttrs,
  SankeyData,
  SankeyLink,
  SankeyNode,
} from '../charts/sankey';

// Node rectangle width; the flow direction is left→right so nodes are thin.
const NODE_W = 14;
// Vertical gap between stacked nodes in a column.
const NODE_GAP = 8;
// Margin around the plot rect (there are no axes to reserve space for).
const PAD = 8;
// Space between a node and its label.
const LABEL_GAP = 4;
const LABEL_FONT_SIZE = 11;
// ~px per char, matching estimateLabelWidth in common.ts.
const CHAR_PX = 6;
const RIBBON_OPACITY = 0.4;
const RIBBON_OPACITY_HOVER = 0.75;

interface NodeLayout {
  readonly node: SankeyNode;
  readonly index: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly throughput: number;
  readonly isLast: boolean;
}

interface LinkLayout {
  readonly link: SankeyLink;
  readonly index: number;
  readonly path: string;
  readonly gradientId: string;
  readonly sourceColor: string;
  readonly targetColor: string;
  readonly x1: number;
  readonly x2: number;
}

interface SankeyLayout {
  readonly nodes: ReadonlyArray<NodeLayout>;
  readonly links: ReadonlyArray<LinkLayout>;
}

// What the pointer is currently over. Carries the display strings so the
// sibling tooltip in view() doesn't need the (imperatively-computed) layout.
type Hovered =
  | {
      readonly kind: 'node';
      readonly index: number;
      readonly name: string;
      readonly throughput: number;
    }
  | {
      readonly kind: 'link';
      readonly index: number;
      readonly source: string;
      readonly target: string;
      readonly value: number;
    };

export class SankeySvg implements m.ClassComponent<SankeyChartAttrs> {
  private hovered?: Hovered;
  // Unique prefix for per-link gradient ids — two charts on a page must not
  // share ids.
  private readonly idPrefix = `pf-sankey-${shortUuid()}`;

  private setHovered(h: Hovered) {
    this.hovered = h;
  }

  private clearHovered(kind: Hovered['kind'], index: number) {
    if (this.hovered?.kind === kind && this.hovered.index === index) {
      this.hovered = undefined;
    }
  }

  view({attrs}: m.Vnode<SankeyChartAttrs>) {
    const {data, height = 200, fillParent, className} = attrs;

    const isLoading = data === undefined;
    const isEmpty =
      data !== undefined &&
      (data.nodes.length === 0 || data.links.length === 0);

    const tooltip = (() => {
      const h = this.hovered;
      if (h === undefined) return false;
      const fmt = attrs.formatValue ?? defaultFmt;
      if (h.kind === 'link') {
        return m(ChartTooltip, [
          m(ChartTooltip.Header, `${h.source} → ${h.target}`),
          m(ChartTooltip.Row, {name: 'Value', value: fmt(h.value)}),
        ]);
      }
      return m(ChartTooltip, [
        m(ChartTooltip.Header, h.name),
        m(ChartTooltip.Row, {name: 'Throughput', value: fmt(h.throughput)}),
      ]);
    })();

    return m(
      '.pf-chart-svg',
      {
        className: classNames(
          fillParent && 'pf-chart-svg--fill-parent',
          className,
        ),
        style: fillParent ? undefined : {height: `${height}px`},
      },
      m(SvgChartFrame, {
        isLoading,
        isEmpty,
        renderChart: (w, h) => this.renderChart(attrs, data!, w, h),
      }),
      tooltip,
    );
  }

  private renderChart(
    attrs: SankeyChartAttrs,
    data: SankeyData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const layout = buildSankeyLayout(data, width, height, this.idPrefix);

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      // Per-link gradients: source colour → target colour along the ribbon.
      m(
        'defs',
        layout.links.map((l) =>
          m(
            'linearGradient',
            {
              id: l.gradientId,
              gradientUnits: 'userSpaceOnUse',
              x1: l.x1,
              y1: 0,
              x2: l.x2,
              y2: 0,
            },
            [
              m('stop', {'offset': '0%', 'stop-color': l.sourceColor}),
              m('stop', {'offset': '100%', 'stop-color': l.targetColor}),
            ],
          ),
        ),
      ),
      // Ribbons first so nodes sit on top of them.
      m(
        'g',
        layout.links.map((l) => {
          const hovered = this.isLinkHovered(l.index);
          return m('path', {
            'd': l.path,
            'fill': `url(#${l.gradientId})`,
            'fill-opacity': hovered ? RIBBON_OPACITY_HOVER : RIBBON_OPACITY,
            'stroke': 'none',
            'onmouseenter': () =>
              this.setHovered({
                kind: 'link',
                index: l.index,
                source: l.link.source,
                target: l.link.target,
                value: l.link.value,
              }),
            'onmouseleave': () => this.clearHovered('link', l.index),
          });
        }),
      ),
      // Node rectangles.
      m(
        'g',
        layout.nodes.map((n) => {
          const hovered = this.isNodeHovered(n.index);
          return m('rect', {
            'x': n.x,
            'y': n.y,
            'width': n.w,
            'height': n.h,
            'fill': n.color,
            'stroke': hovered ? 'currentColor' : 'none',
            'stroke-width': hovered ? 2 : 0,
            'style': attrs.onNodeClick && {cursor: 'pointer'},
            'onmouseenter': () =>
              this.setHovered({
                kind: 'node',
                index: n.index,
                name: n.node.name,
                throughput: n.throughput,
              }),
            'onmouseleave': () => this.clearHovered('node', n.index),
            'onclick': attrs.onNodeClick && (() => attrs.onNodeClick!(n.node)),
          });
        }),
      ),
      // Labels: right of each node, or left-aligned for the last column.
      m(
        'g',
        {'pointer-events': 'none'},
        layout.nodes.map((n) => {
          // Available horizontal room for the label, so we truncate to fit.
          const maxPx = n.isLast
            ? n.x - LABEL_GAP - PAD
            : width - PAD - (n.x + n.w + LABEL_GAP);
          const text = truncateLabel(n.node.name, maxPx);
          if (text === '') return undefined;
          return m(
            'text',
            {
              'x': n.isLast ? n.x - LABEL_GAP : n.x + n.w + LABEL_GAP,
              'y': n.y + n.h / 2,
              'fill': 'currentColor',
              'font-size': LABEL_FONT_SIZE,
              'text-anchor': n.isLast ? 'end' : 'start',
              'dominant-baseline': 'middle',
            },
            text,
          );
        }),
      ),
    );
  }

  private isLinkHovered(index: number): boolean {
    return this.hovered?.kind === 'link' && this.hovered.index === index;
  }

  private isNodeHovered(index: number): boolean {
    return this.hovered?.kind === 'node' && this.hovered.index === index;
  }
}

// Compute a layered left→right Sankey layout. The graph is small and acyclic
// so a simple relaxation over the links resolves node depths.
function buildSankeyLayout(
  data: SankeyData,
  width: number,
  height: number,
  idPrefix: string,
): SankeyLayout {
  const {nodes, links} = data;
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.name, i));

  // Depth = explicit node.depth when set, else the longest path from a source
  // root. Relax over links until stable (bounded by node count).
  const depth = nodes.map((n) => n.depth ?? 0);
  const explicit = nodes.map((n) => n.depth !== undefined);
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const link of links) {
      const si = nodeIndex.get(link.source);
      const ti = nodeIndex.get(link.target);
      if (si === undefined || ti === undefined || explicit[ti]) continue;
      const d = depth[si] + 1;
      if (d > depth[ti]) {
        depth[ti] = d;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = depth.reduce((a, b) => Math.max(a, b), 0);

  // Throughput = max(total inflow, total outflow); it drives node height.
  const inflow = nodes.map(() => 0);
  const outflow = nodes.map(() => 0);
  for (const link of links) {
    const si = nodeIndex.get(link.source);
    const ti = nodeIndex.get(link.target);
    if (si !== undefined) outflow[si] += link.value;
    if (ti !== undefined) inflow[ti] += link.value;
  }
  const throughput = nodes.map((_, i) => Math.max(inflow[i], outflow[i]));

  // Group nodes into columns by depth (keeping original order for stacking).
  const columns: number[][] = [];
  for (let d = 0; d <= maxDepth; d++) columns.push([]);
  nodes.forEach((_, i) => columns[depth[i]].push(i));

  const plotTop = PAD;
  const plotH = Math.max(0, height - 2 * PAD);
  const innerLeft = PAD;
  const innerRight = width - PAD;
  const availX = Math.max(0, innerRight - innerLeft - NODE_W);
  const numCols = maxDepth + 1;
  const columnX = (d: number) =>
    numCols > 1 ? innerLeft + (d / (numCols - 1)) * availX : innerLeft;

  // Vertical value→pixel scale, chosen so the tallest column fills the plot.
  let scale = Infinity;
  for (const col of columns) {
    let total = 0;
    for (const i of col) total += throughput[i];
    if (total <= 0) continue;
    const avail = plotH - NODE_GAP * (col.length - 1);
    scale = Math.min(scale, avail / total);
  }
  if (!isFinite(scale) || scale <= 0) scale = 0;

  // Place each column's nodes, centred vertically within the plot.
  const nodeLayouts: NodeLayout[] = new Array(nodes.length);
  columns.forEach((col, d) => {
    let colH = NODE_GAP * (col.length - 1);
    for (const i of col) colH += throughput[i] * scale;
    let cursorY = plotTop + (plotH - colH) / 2;
    const x = columnX(d);
    for (const i of col) {
      const h = throughput[i] * scale;
      nodeLayouts[i] = {
        node: nodes[i],
        index: i,
        depth: d,
        x,
        y: cursorY,
        w: NODE_W,
        h,
        color: nodes[i].color ?? chartColorVar(d),
        throughput: throughput[i],
        isLast: d === maxDepth,
      };
      cursorY += h + NODE_GAP;
    }
  });

  // Ribbons: stack each link at its source and target in link order. A ribbon
  // is a filled cubic-bezier band whose thickness ∝ value.
  const sourceCursor = nodeLayouts.map((n) => n.y);
  const targetCursor = nodeLayouts.map((n) => n.y);
  const linkLayouts: LinkLayout[] = [];
  links.forEach((link, index) => {
    const si = nodeIndex.get(link.source);
    const ti = nodeIndex.get(link.target);
    if (si === undefined || ti === undefined) return;
    const sNode = nodeLayouts[si];
    const tNode = nodeLayouts[ti];
    const thickness = link.value * scale;
    const sy0 = sourceCursor[si];
    const ty0 = targetCursor[ti];
    sourceCursor[si] += thickness;
    targetCursor[ti] += thickness;
    const sx = sNode.x + NODE_W;
    const tx = tNode.x;
    const midX = (sx + tx) / 2;
    const sy1 = sy0 + thickness;
    const ty1 = ty0 + thickness;
    const path =
      `M${sx},${sy0} ` +
      `C${midX},${sy0} ${midX},${ty0} ${tx},${ty0} ` +
      `L${tx},${ty1} ` +
      `C${midX},${ty1} ${midX},${sy1} ${sx},${sy1} Z`;
    linkLayouts.push({
      link,
      index,
      path,
      gradientId: `${idPrefix}-grad-${index}`,
      sourceColor: sNode.color,
      targetColor: tNode.color,
      x1: sx,
      x2: tx,
    });
  });

  return {nodes: nodeLayouts, links: linkLayouts};
}

// Truncate a label to roughly fit `maxPx`, appending an ellipsis when cut.
function truncateLabel(text: string, maxPx: number): string {
  const maxChars = Math.floor(maxPx / CHAR_PX);
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  return text.slice(0, maxChars - 1) + '…';
}
