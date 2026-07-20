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
import type {
  TreemapChartAttrs,
  TreemapData,
  TreemapNode,
} from '../charts/treemap';
import {chartColorVar, defaultFmt} from './common';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {
  TreemapChartAttrs,
  TreemapData,
  TreemapNode,
} from '../charts/treemap';

// Height (px) of the header strip drawn above a parent's children so the
// parent's name has somewhere to live once we recurse one level in.
const HEADER_PX = 16;
// Height (px) reserved at the top of the plot for the drill-down breadcrumb.
const BREADCRUMB_PX = 18;
// A parent only gets a header + nested children if its cell is at least this
// big; smaller parents are drawn as a single solid cell.
const MIN_NEST_W = 24;
const MIN_NEST_H = HEADER_PX + 8;
// Leaf cells narrower/shorter than this don't get a label — the text wouldn't
// fit and would just spill over the neighbours.
const MIN_LABEL_W = 24;
const MIN_LABEL_H = 12;
// Inset (px) of a cell's label from its top-left corner.
const LABEL_PAD = 3;
// Rough px-per-character estimate, matching estimateLabelWidth in common.ts.
const CHAR_PX = 6;
// Cells are separated by a thin stroke in the container background colour so
// adjacent cells read as distinct even when their fills are similar.
const CELL_STROKE = 'var(--pf-color-background)';
// Parents are drawn faint so their (brighter) children stand out on top.
const PARENT_OPACITY = 0.25;
const LEAF_OPACITY = 0.85;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// A laid-out cell in chart space: the source node plus its pixel rectangle,
// colour (inherited from the top-level ancestor) and drawing metadata.
interface Cell {
  readonly node: TreemapNode;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly opacity: number;
  // True when this cell drew a header strip and nested children below it, so
  // its label sits in the strip rather than the cell's top-left corner.
  readonly header: boolean;
  // Whether the source node has children at all (drives drill-down), even if
  // none are visible after the visibleMin filter.
  readonly hasChildren: boolean;
}

interface HoverState {
  readonly node: TreemapNode;
  readonly value: number;
  readonly color: string;
  readonly pct: number;
}

export class TreemapSvg implements m.ClassComponent<TreemapChartAttrs> {
  private hover?: HoverState;
  // Path of node names from the tree root down to the current drill-down
  // root. Empty means the full tree is shown.
  private drillPath: ReadonlyArray<string> = [];

  view({attrs}: m.Vnode<TreemapChartAttrs>) {
    const {data, height = 200, fillParent, className} = attrs;

    const isLoading = data === undefined;
    const isEmpty = data !== undefined && data.nodes.length === 0;

    const tooltip = (() => {
      if (this.hover === undefined) return false;
      const formatValue = attrs.formatValue ?? defaultFmt;
      const h = this.hover;
      return m(ChartTooltip, [
        m(ChartTooltip.Header, h.node.name),
        m(ChartTooltip.Row, {
          name: 'Value',
          value: formatValue(h.value),
          swatch: h.color,
        }),
        m(ChartTooltip.Row, {name: '%', value: `${h.pct.toFixed(1)}%`}),
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
    attrs: TreemapChartAttrs,
    data: TreemapData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const visibleMin = attrs.visibleMin ?? 10;
    const showLabels = attrs.showLabels ?? true;
    const enableDrillDown = attrs.enableDrillDown ?? false;

    // Resolve the drill-down root: walk the stored name path from the tree
    // root. If any link is broken (e.g. the data changed underneath us),
    // fall back to the full tree.
    let topNodes: ReadonlyArray<TreemapNode> = data.nodes;
    let drilledName: string | undefined;
    if (this.drillPath.length > 0) {
      let nodes: ReadonlyArray<TreemapNode> = data.nodes;
      let node: TreemapNode | undefined;
      for (const name of this.drillPath) {
        node = nodes.find((n) => n.name === name);
        if (node === undefined) break;
        nodes = node.children ?? [];
      }
      if (node !== undefined) {
        topNodes = node.children ?? [];
        drilledName = node.name;
      } else {
        this.drillPath = [];
      }
    }

    const breadcrumbH = drilledName !== undefined ? BREADCRUMB_PX : 0;
    const plot: Rect = {
      x: 0,
      y: breadcrumbH,
      w: width,
      h: Math.max(0, height - breadcrumbH),
    };

    // Top-level items, filtered to the visible ones and laid out squarified.
    const items = topNodes
      .map((node) => ({node, value: nodeValue(node)}))
      .filter((e) => e.value >= visibleMin && e.value > 0);
    const total = items.reduce((sum, e) => sum + e.value, 0);
    const rects = squarify(
      items.map((e) => e.value),
      plot,
    );

    const cells: Cell[] = [];
    items.forEach((item, i) => {
      const color = chartColorVar(i);
      const rect = rects[i];
      const kids = (item.node.children ?? [])
        .map((node) => ({node, value: nodeValue(node)}))
        .filter((e) => e.value >= visibleMin && e.value > 0);
      const hasChildren = (item.node.children ?? []).length > 0;
      const canNest =
        kids.length > 0 && rect.w >= MIN_NEST_W && rect.h >= MIN_NEST_H;

      if (canNest) {
        cells.push({
          node: item.node,
          value: item.value,
          ...rect,
          color,
          opacity: PARENT_OPACITY,
          header: true,
          hasChildren,
        });
        const inner: Rect = {
          x: rect.x,
          y: rect.y + HEADER_PX,
          w: rect.w,
          h: rect.h - HEADER_PX,
        };
        const kidRects = squarify(
          kids.map((e) => e.value),
          inner,
        );
        kids.forEach((kid, j) => {
          cells.push({
            node: kid.node,
            value: kid.value,
            ...kidRects[j],
            color,
            opacity: LEAF_OPACITY,
            header: false,
            hasChildren: (kid.node.children ?? []).length > 0,
          });
        });
      } else {
        cells.push({
          node: item.node,
          value: item.value,
          ...rect,
          color,
          opacity: hasChildren ? PARENT_OPACITY : LEAF_OPACITY,
          header: false,
          hasChildren,
        });
      }
    });

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        onpointerleave: () => {
          if (this.hover !== undefined) this.hover = undefined;
        },
      },
      m(
        'g',
        {'shape-rendering': 'crispEdges'},
        cells.map((cell) =>
          this.renderCell(attrs, cell, total, showLabels, enableDrillDown),
        ),
      ),
      drilledName !== undefined &&
        this.renderBreadcrumb(drilledName, breadcrumbH, width),
    );
  }

  private renderCell(
    attrs: TreemapChartAttrs,
    cell: Cell,
    total: number,
    showLabels: boolean,
    enableDrillDown: boolean,
  ): m.Children {
    const hovered = this.hover?.node === cell.node;
    const fillOpacity = hovered
      ? Math.min(1, cell.opacity + 0.15)
      : cell.opacity;
    return m('g', [
      m('rect', {
        'x': cell.x,
        'y': cell.y,
        'width': Math.max(0, cell.w),
        'height': Math.max(0, cell.h),
        'fill': cell.color,
        'fill-opacity': fillOpacity,
        'stroke': hovered ? 'var(--pf-color-accent)' : CELL_STROKE,
        'stroke-width': hovered ? 2 : 1,
        'style': {cursor: 'pointer'},
        'onpointerenter': () => {
          this.hover = {
            node: cell.node,
            value: cell.value,
            color: cell.color,
            pct: total > 0 ? (cell.value / total) * 100 : 0,
          };
        },
        'onclick': () => {
          attrs.onNodeClick?.(cell.node);
          if (enableDrillDown && cell.hasChildren) {
            this.drillPath = [...this.drillPath, cell.node.name];
            this.hover = undefined;
          }
        },
      }),
      showLabels && this.renderLabel(cell),
    ]);
  }

  private renderLabel(cell: Cell): m.Children {
    const availW = cell.w - LABEL_PAD * 2;
    let y: number;
    let baseline: string;
    if (cell.header) {
      if (cell.h < HEADER_PX) return undefined;
      y = cell.y + HEADER_PX / 2;
      baseline = 'central';
    } else {
      if (cell.h < MIN_LABEL_H || cell.w < MIN_LABEL_W) return undefined;
      y = cell.y + LABEL_PAD;
      baseline = 'hanging';
    }
    const text = truncateToWidth(cell.node.name, availW);
    if (text === undefined) return undefined;
    return m(
      'text',
      {
        'x': cell.x + LABEL_PAD,
        'y': y,
        'fill': 'var(--pf-color-text)',
        'font-size': 11,
        'dominant-baseline': baseline,
        'pointer-events': 'none',
      },
      text,
    );
  }

  private renderBreadcrumb(
    name: string,
    breadcrumbH: number,
    width: number,
  ): m.Children {
    return m(
      'g',
      {
        style: {cursor: 'pointer'},
        onclick: () => {
          this.drillPath = [];
          this.hover = undefined;
        },
      },
      m('rect', {
        x: 0,
        y: 0,
        width,
        height: breadcrumbH,
        fill: 'var(--pf-color-background)',
      }),
      m(
        'text',
        {
          'x': LABEL_PAD,
          'y': breadcrumbH / 2,
          'fill': 'var(--pf-color-text)',
          'font-size': 11,
          'font-weight': 'bold',
          'dominant-baseline': 'central',
        },
        `⬑ ${name}`,
      ),
    );
  }
}

// A node's area weight: its own value, or the sum of its children when the
// value is 0 (parents whose size is implied by their contents).
function nodeValue(node: TreemapNode): number {
  if (node.value > 0) return node.value;
  const kids = node.children;
  if (kids !== undefined && kids.length > 0) {
    let sum = 0;
    for (const k of kids) sum += nodeValue(k);
    return sum;
  }
  return node.value;
}

// Truncate `text` with an ellipsis so it fits `maxW` px, or undefined when the
// cell is too narrow for even a couple of characters.
function truncateToWidth(text: string, maxW: number): string | undefined {
  const maxChars = Math.floor(maxW / CHAR_PX);
  if (maxChars < 2) return undefined;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

// Squarified treemap layout (Bruls, Huizing & van Wijk 2000). Lays `values`
// (each ∝ its desired area) into `rect`, greedily growing a row along the
// shorter side while the row's worst aspect ratio keeps improving, then
// flushing it and starting the next row in the remaining free rectangle.
// Output rectangles are returned in the same order as `values`.
function squarify(values: ReadonlyArray<number>, rect: Rect): Rect[] {
  const out: Rect[] = [];
  const total = values.reduce((a, b) => a + b, 0);
  if (values.length === 0 || rect.w <= 0 || rect.h <= 0 || total <= 0) {
    for (let i = 0; i < values.length; i++) {
      out.push({x: rect.x, y: rect.y, w: 0, h: 0});
    }
    return out;
  }

  // Scale the values so their combined area exactly fills the rectangle.
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => v * scale);

  // The worst (largest) aspect ratio in a row laid along a side of length
  // `side`. Lower is squarer, hence better.
  const worst = (row: ReadonlyArray<number>, side: number): number => {
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const a of row) {
      sum += a;
      if (a > max) max = a;
      if (a < min) min = a;
    }
    const s2 = side * side;
    const sum2 = sum * sum;
    if (sum2 === 0 || min === 0) return Infinity;
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
  };

  let free: Rect = {...rect};
  let row: number[] = [];

  const flushRow = () => {
    const sum = row.reduce((a, b) => a + b, 0);
    if (free.w >= free.h) {
      // A column down the left edge, its width fixed by the row's total.
      const colW = free.h > 0 ? sum / free.h : 0;
      let cy = free.y;
      for (const a of row) {
        const cellH = colW > 0 ? a / colW : 0;
        out.push({x: free.x, y: cy, w: colW, h: cellH});
        cy += cellH;
      }
      free = {x: free.x + colW, y: free.y, w: free.w - colW, h: free.h};
    } else {
      // A row along the top edge, its height fixed by the row's total.
      const rowH = free.w > 0 ? sum / free.w : 0;
      let cx = free.x;
      for (const a of row) {
        const cellW = rowH > 0 ? a / rowH : 0;
        out.push({x: cx, y: free.y, w: cellW, h: rowH});
        cx += cellW;
      }
      free = {x: free.x, y: free.y + rowH, w: free.w, h: free.h - rowH};
    }
    row = [];
  };

  for (const a of areas) {
    const side = Math.min(free.w, free.h);
    if (row.length === 0 || worst([...row, a], side) <= worst(row, side)) {
      row.push(a);
    } else {
      flushRow();
      row.push(a);
    }
  }
  if (row.length > 0) flushRow();

  return out;
}
