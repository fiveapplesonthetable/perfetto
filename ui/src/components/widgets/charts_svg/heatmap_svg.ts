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
import {clamp} from '../../../base/math_utils';
import {shortUuid} from '../../../base/uuid';
import type {HeatmapAttrs, HeatmapData} from '../charts/heatmap';
import {
  AXIS_LABEL_FONT_SIZE,
  TICK_LABEL_GAP,
  TICK_LENGTH,
  computePlotLayout,
  defaultFmt,
  estimateLabelWidth,
  renderPlotFrame,
} from './common';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

// Single-hue ramp: every cell is drawn in this colour and the *opacity*
// encodes the value, giving a theme-correct light→dark ramp.
const CELL_COLOR = 'var(--pf-chart-color-1)';
const MIN_CELL_OPACITY = 0.15;
const MAX_CELL_OPACITY = 1.0;
// Right-hand padding reserved for the value legend (gradient bar + labels).
// computePlotLayout doesn't know about it, so we add it manually.
const LEGEND_RESERVED = 48;
const LEGEND_BAR_WIDTH = 12;

// Grid cell in index space.
interface HoverState {
  readonly xi: number;
  readonly yi: number;
}

export class HeatmapSvg implements m.ClassComponent<HeatmapAttrs> {
  private hover?: HoverState;
  // Active brush drag state, in *cell-index space* so a resize mid-drag
  // doesn't mangle the selection. `moved` guards against a bare click
  // (pointerdown+up with no motion) emitting an empty selection.
  private brushing?: {
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    pointerId: number;
    moved: boolean;
  };
  private readonly clipId = `pf-chart-clip-${shortUuid()}`;
  private readonly gradientId = `pf-chart-gradient-${shortUuid()}`;

  view({attrs}: m.Vnode<HeatmapAttrs>) {
    const {data} = attrs;
    const isLoading = data === undefined;
    const isEmpty =
      data !== undefined &&
      (data.values.length === 0 ||
        data.xLabels.length === 0 ||
        data.yLabels.length === 0);

    const tooltip = (() => {
      if (this.hover === undefined || data === undefined) return false;
      const {xi, yi} = this.hover;
      const xLabel = data.xLabels[xi];
      const yLabel = data.yLabels[yi];
      if (xLabel === undefined || yLabel === undefined) return false;
      const fmtVal = attrs.formatValue ?? defaultFmt;
      const value = valueAt(data, xi, yi);
      return m(ChartTooltip, [
        m(ChartTooltip.Header, `${xLabel} / ${yLabel}`),
        m(ChartTooltip.Row, {name: 'Value', value: fmtVal(value)}),
      ]);
    })();

    return m(
      '.pf-chart-svg',
      {
        className: classNames(
          attrs.fillParent && 'pf-chart-svg--fill-parent',
          attrs.className,
        ),
        style: attrs.fillParent
          ? undefined
          : {height: `${attrs.height ?? 300}px`},
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
    attrs: HeatmapAttrs,
    data: HeatmapData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const fmtVal = attrs.formatValue ?? defaultFmt;
    const xLabels = data.xLabels;
    const yLabels = data.yLabels;
    const nCols = xLabels.length;
    const nRows = yLabels.length;

    // Sparse value lookup: missing cells read as 0.
    const valueMap = new Map<number, number>();
    for (const [xi, yi, v] of data.values) valueMap.set(yi * nCols + xi, v);
    const cellValue = (xi: number, yi: number) =>
      valueMap.get(yi * nCols + xi) ?? 0;

    // Layout. computePlotLayout sizes the left padding from the widest Y
    // label; we reserve extra right padding for the value legend by hand.
    const xName = attrs.xAxisLabel;
    const yName = attrs.yAxisLabel;
    const base = computePlotLayout({width, height, yLabels, xName, yName});
    const padRight = base.padRight + LEGEND_RESERVED;
    const plotW = Math.max(0, width - base.padLeft - padRight);
    const layout = {...base, padRight, plotW};
    const {padLeft, padTop, plotH} = layout;

    const cellW = nCols > 0 ? plotW / nCols : 0;
    const cellH = nRows > 0 ? plotH / nRows : 0;

    // Column xi grows left→right; row yi grows bottom→top (matching the
    // categorical Y axis convention).
    const colX = (xi: number) => padLeft + xi * cellW;
    const rowTop = (yi: number) => padTop + plotH - (yi + 1) * cellH;
    const colCenter = (xi: number) => colX(xi) + cellW / 2;
    const rowCenter = (yi: number) => rowTop(yi) + cellH / 2;

    // Colour ramp: opacity encodes the value.
    const span = data.max - data.min;
    const cellOpacity = (value: number) => {
      const t = span > 0 ? clamp((value - data.min) / span, 0, 1) : 0.5;
      return MIN_CELL_OPACITY + (MAX_CELL_OPACITY - MIN_CELL_OPACITY) * t;
    };

    // Hit-testing: client coords → cell index. Returns -1 when outside.
    const xToCol = (clientX: number, rectLeft: number): number => {
      const px = clientX - rectLeft - padLeft;
      if (px < 0 || px >= plotW || cellW <= 0) return -1;
      return clamp(Math.floor(px / cellW), 0, nCols - 1);
    };
    const yToRow = (clientY: number, rectTop: number): number => {
      const py = clientY - rectTop - padTop;
      if (py < 0 || py >= plotH || cellH <= 0) return -1;
      const rowFromTop = Math.floor(py / cellH);
      return clamp(nRows - 1 - rowFromTop, 0, nRows - 1);
    };

    // Selection highlight: a cell is selected iff its X label AND Y label are
    // both in the external selection sets.
    const sel = attrs.selection;
    const xSet = sel !== undefined ? new Set(sel.xLabels) : undefined;
    const ySet = sel !== undefined ? new Set(sel.yLabels) : undefined;
    const isSelected = (xi: number, yi: number): boolean =>
      xSet !== undefined &&
      ySet !== undefined &&
      xSet.has(xLabels[xi]) &&
      ySet.has(yLabels[yi]);

    // X labels: thin or rotate when they don't fit under a column.
    const maxXLabelPx = estimateLabelWidth(xLabels);
    const rotateX = maxXLabelPx > cellW;
    const xLabelStep = rotateX
      ? Math.max(1, Math.ceil(14 / Math.max(1, cellW)))
      : Math.max(1, Math.ceil((maxXLabelPx + 4) / Math.max(1, cellW)));

    // Brush overlay rect (live drag), in cell-index space.
    const brushRect = (() => {
      if (this.brushing === undefined) return undefined;
      const {startX, startY, curX, curY} = this.brushing;
      const loX = Math.min(startX, curX);
      const hiX = Math.max(startX, curX);
      const loY = Math.min(startY, curY);
      const hiY = Math.max(startY, curY);
      const x = colX(loX);
      const w = colX(hiX) + cellW - x;
      // rowTop(hiY) is the top of the highest row (largest index).
      const y = rowTop(hiY);
      const hgt = rowTop(loY) + cellH - y;
      return {x, y, w, h: hgt};
    })();

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: attrs.onBrush && {cursor: 'crosshair'},
        oncontextmenu: (e: Event) => e.preventDefault(),
        onpointerdown:
          attrs.onBrush &&
          ((e: PointerEvent) => this.handleBrushDown(e, xToCol, yToRow)),
        onpointermove: (e: PointerEvent) =>
          this.handlePointerMove(e, xToCol, yToRow),
        onpointerup:
          attrs.onBrush &&
          ((e: PointerEvent) =>
            this.handleBrushUp(e, attrs.onBrush!, xLabels, yLabels)),
        onpointerleave: () => {
          if (this.brushing) return;
          if (this.hover !== undefined) this.hover = undefined;
        },
        onlostpointercapture: () => {
          this.brushing = undefined;
        },
      },
      m(
        'defs',
        m(
          'clipPath',
          {id: this.clipId},
          m('rect', {x: padLeft, y: padTop, width: plotW, height: plotH}),
        ),
        // Vertical value-legend gradient: opacity 0.15 (bottom/min) → 1.0
        // (top/max) of the cell colour.
        m(
          'linearGradient',
          {id: this.gradientId, x1: 0, y1: 1, x2: 0, y2: 0},
          m('stop', {
            'offset': '0%',
            'stop-color': CELL_COLOR,
            'stop-opacity': MIN_CELL_OPACITY,
          }),
          m('stop', {
            'offset': '100%',
            'stop-color': CELL_COLOR,
            'stop-opacity': MAX_CELL_OPACITY,
          }),
        ),
      ),
      renderPlotFrame({
        layout,
        height,
        xName,
        yName,
        yTicks: yLabels.map((label, yi) => ({label, y: rowCenter(yi)})),
      }),
      // Cells. A 1px background-coloured stroke gives the inter-cell gap.
      m(
        'g',
        {'clip-path': `url(#${this.clipId})`, 'shape-rendering': 'crispEdges'},
        data.xLabels.map((_, xi) =>
          data.yLabels.map((__, yi) =>
            m('rect', {
              'x': colX(xi),
              'y': rowTop(yi),
              'width': Math.max(0, cellW),
              'height': Math.max(0, cellH),
              'fill': CELL_COLOR,
              'fill-opacity': cellOpacity(cellValue(xi, yi)),
              'stroke': 'var(--pf-color-background)',
              'stroke-width': 1,
              'pointer-events': 'none',
            }),
          ),
        ),
      ),
      // Selection + hover overlays (drawn on top, not hit-testable).
      m(
        'g',
        {
          'clip-path': `url(#${this.clipId})`,
          'pointer-events': 'none',
          'shape-rendering': 'crispEdges',
        },
        data.xLabels.map((_, xi) =>
          data.yLabels.map((__, yi) => {
            if (!isSelected(xi, yi)) return undefined;
            return m('rect', {
              'className': 'pf-chart-svg__selection',
              'x': colX(xi),
              'y': rowTop(yi),
              'width': Math.max(0, cellW),
              'height': Math.max(0, cellH),
              'fill': 'currentColor',
              'stroke': 'currentColor',
              'stroke-width': 2,
            });
          }),
        ),
        this.hover !== undefined &&
          m('rect', {
            'x': colX(this.hover.xi),
            'y': rowTop(this.hover.yi),
            'width': Math.max(0, cellW),
            'height': Math.max(0, cellH),
            'fill': 'none',
            'stroke': 'var(--pf-color-accent)',
            'stroke-width': 2,
          }),
      ),
      // X ticks + category labels (thinned or rotated to fit).
      data.xLabels.map((label, xi) => {
        if (xi % xLabelStep !== 0) return undefined;
        const cx = colCenter(xi);
        const ty = padTop + plotH + TICK_LENGTH + TICK_LABEL_GAP;
        return m('g', [
          m('line', {
            className: 'pf-chart-svg__line',
            x1: cx,
            y1: padTop + plotH,
            x2: cx,
            y2: padTop + plotH + TICK_LENGTH,
            stroke: 'currentColor',
          }),
          m(
            'text',
            {
              'className': 'pf-chart-svg__tick-label',
              'x': cx,
              'y': ty,
              'fill': 'currentColor',
              'text-anchor': rotateX ? 'end' : 'middle',
              'dominant-baseline': 'hanging',
              'transform': rotateX ? `rotate(-45 ${cx} ${ty})` : undefined,
            },
            label,
          ),
        ]);
      }),
      // Value legend: gradient bar + min/max labels on the right edge.
      this.renderLegend(layout, width, fmtVal(data.min), fmtVal(data.max)),
      // Brush selection rectangle (live drag).
      brushRect &&
        m('rect', {
          'className': 'pf-chart-svg__brush',
          'x': brushRect.x,
          'y': brushRect.y,
          'width': Math.max(0, brushRect.w),
          'height': Math.max(0, brushRect.h),
          'fill': 'currentColor',
          'stroke': 'currentColor',
          'stroke-width': 1,
          'pointer-events': 'none',
        }),
    );
  }

  private renderLegend(
    layout: {padLeft: number; padTop: number; plotW: number; plotH: number},
    width: number,
    minLabel: string,
    maxLabel: string,
  ): m.Children {
    const {padLeft, padTop, plotW, plotH} = layout;
    const barX = padLeft + plotW + 8;
    const labelX = barX + LEGEND_BAR_WIDTH + 4;
    if (barX + LEGEND_BAR_WIDTH > width) return undefined;
    return m('g', [
      m('rect', {
        'x': barX,
        'y': padTop,
        'width': LEGEND_BAR_WIDTH,
        'height': plotH,
        'fill': `url(#${this.gradientId})`,
        'stroke': 'var(--pf-color-border)',
        'stroke-width': 1,
      }),
      m(
        'text',
        {
          'className': 'pf-chart-svg__tick-label',
          'x': labelX,
          'y': padTop,
          'fill': 'currentColor',
          'text-anchor': 'start',
          'dominant-baseline': 'hanging',
          'font-size': AXIS_LABEL_FONT_SIZE,
        },
        maxLabel,
      ),
      m(
        'text',
        {
          'className': 'pf-chart-svg__tick-label',
          'x': labelX,
          'y': padTop + plotH,
          'fill': 'currentColor',
          'text-anchor': 'start',
          'dominant-baseline': 'auto',
          'font-size': AXIS_LABEL_FONT_SIZE,
        },
        minLabel,
      ),
    ]);
  }

  private handleBrushDown(
    e: PointerEvent,
    xToCol: (clientX: number, rectLeft: number) => number,
    yToRow: (clientY: number, rectTop: number) => number,
  ) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const col = xToCol(e.clientX, rect.left);
    const row = yToRow(e.clientY, rect.top);
    if (col < 0 || row < 0) return;
    svg.setPointerCapture(e.pointerId);
    this.brushing = {
      startX: col,
      startY: row,
      curX: col,
      curY: row,
      pointerId: e.pointerId,
      moved: false,
    };
    this.hover = undefined;
    e.preventDefault();
  }

  private handleBrushUp(
    e: PointerEvent,
    onBrush: NonNullable<HeatmapAttrs['onBrush']>,
    xLabels: readonly string[],
    yLabels: readonly string[],
  ) {
    if (!this.brushing || this.brushing.pointerId !== e.pointerId) return;
    const {startX, startY, curX, curY, moved} = this.brushing;
    this.brushing = undefined;
    // Bare click (no drag) must not emit.
    if (!moved) return;
    const loX = Math.min(startX, curX);
    const hiX = Math.max(startX, curX);
    const loY = Math.min(startY, curY);
    const hiY = Math.max(startY, curY);
    const selX: string[] = [];
    for (let xi = loX; xi <= hiX; xi++) selX.push(xLabels[xi]);
    const selY: string[] = [];
    for (let yi = loY; yi <= hiY; yi++) selY.push(yLabels[yi]);
    if (selX.length > 0 && selY.length > 0) {
      onBrush({xLabels: selX, yLabels: selY});
    }
  }

  private handlePointerMove(
    e: PointerEvent,
    xToCol: (clientX: number, rectLeft: number) => number,
    yToRow: (clientY: number, rectTop: number) => number,
  ) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (this.brushing && this.brushing.pointerId === e.pointerId) {
      const col = xToCol(e.clientX, rect.left);
      const row = yToRow(e.clientY, rect.top);
      // Dragging outside the plot keeps the last in-bounds edge.
      this.brushing = {
        ...this.brushing,
        curX: col >= 0 ? col : this.brushing.curX,
        curY: row >= 0 ? row : this.brushing.curY,
        moved: true,
      };
      this.hover = undefined;
      return;
    }
    const col = xToCol(e.clientX, rect.left);
    const row = yToRow(e.clientY, rect.top);
    if (col < 0 || row < 0) {
      if (this.hover !== undefined) this.hover = undefined;
      return;
    }
    if (this.hover?.xi !== col || this.hover?.yi !== row) {
      this.hover = {xi: col, yi: row};
    }
  }
}

// Value at cell (xi,yi). Missing triples are treated as 0. Linear scan keeps
// this allocation-free; grids are small (categorical axes).
function valueAt(data: HeatmapData, xi: number, yi: number): number {
  for (const [x, y, v] of data.values) {
    if (x === xi && y === yi) return v;
  }
  return 0;
}
