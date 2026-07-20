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
import {max, min} from '../../../base/array_utils';
import {clamp} from '../../../base/math_utils';
import {shortUuid} from '../../../base/uuid';
import type {ScatterChartAttrs, ScatterChartData} from '../charts/scatterplot';
import {
  type AxisRange,
  TICK_LABEL_GAP,
  TICK_LENGTH,
  chartColorVar,
  computePlotLayout,
  defaultFmt,
  logRange,
  niceRange,
  rangeWithFixedBounds,
  renderPlotFrame,
} from './common';
import {ChartLegend} from './legend';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {
  ScatterChartAttrs,
  ScatterChartData,
  ScatterChartPoint,
  ScatterChartSeries,
} from '../charts/scatterplot';

// Default point diameter (px) when no per-point size is supplied.
const DEFAULT_SYMBOL_SIZE = 8;
// Default diameter range (px) that per-point `.size` values map onto.
const DEFAULT_SYMBOL_SIZE_RANGE: [number, number] = [5, 30];
// Extra pixels of slack around a point's radius when hit-testing hovers.
const HOVER_SLOP_PX = 4;
// Minimum pointer travel (px, either axis) that separates a brush drag from a
// bare click — a click must not emit a selection.
const DRAG_THRESHOLD_PX = 3;

// Default fill for highlight bands: a neutral grey that reads in both themes.
const HIGHLIGHT_BAND_COLOR = 'rgba(128, 128, 128, 0.25)';

// Point in chart-space: data x/y plus its pre-computed pixel radius.
interface PointPlot {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: string;
  readonly label?: string;
}

interface SeriesPlot {
  readonly name: string;
  readonly color: string;
  readonly points: ReadonlyArray<PointPlot>;
}

// Everything needed to map between data- and pixel-space. Passed to the
// pointer handlers so they can hit-test without re-deriving the layout.
interface Geom {
  readonly padLeft: number;
  readonly padTop: number;
  readonly plotW: number;
  readonly plotH: number;
  readonly xRange: AxisRange;
  readonly yRange: AxisRange;
  readonly logX: boolean;
  readonly logY: boolean;
}

// Resolved hover: values are snapshotted so the tooltip (built in view()) and
// the emphasis ring (drawn in renderChart) don't need the plot arrays.
interface HoverState {
  readonly seriesName: string;
  readonly color: string;
  readonly r: number;
  readonly x: number;
  readonly y: number;
  readonly label?: string;
}

export class ScatterSvg implements m.ClassComponent<ScatterChartAttrs> {
  private hover?: HoverState;
  // Index of the currently-hovered series (original data index), if any.
  private hoveredSeries?: number;
  // Active 2D brush drag, in *data* coordinates so a resize mid-drag doesn't
  // mangle the rectangle. Pointer capture keeps the drag bound to the SVG.
  private brushing?: {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    pointerId: number;
  };
  private readonly clipId = `pf-chart-clip-${shortUuid()}`;
  // Series toggled off via legend click, keyed by series name.
  private hiddenSeries = new Set<string>();

  private toggleSeries(name: string) {
    if (this.hiddenSeries.has(name)) {
      this.hiddenSeries.delete(name);
    } else {
      this.hiddenSeries.add(name);
    }
    // A hidden series may have been the hovered point — drop it.
    this.hover = undefined;
  }

  private setHoveredSeries(i: number) {
    if (this.hoveredSeries !== i) {
      this.hoveredSeries = i;
    }
  }

  private clearHoveredSeries(i: number) {
    if (this.hoveredSeries === i) {
      this.hoveredSeries = undefined;
    }
  }

  view({attrs}: m.Vnode<ScatterChartAttrs>) {
    const {
      data,
      legendPosition = 'top',
      showLegend = data !== undefined && data.series.length > 1,
      formatYValue = defaultFmt,
      formatXValue = defaultFmt,
      height = 200,
      fillParent,
      className,
    } = attrs;

    const isLoading = data === undefined;
    const isEmpty =
      data !== undefined &&
      (data.series.length === 0 ||
        data.series.every((s) => s.points.length === 0));

    const legend =
      showLegend &&
      data !== undefined &&
      m(
        ChartLegend,
        data.series.map((s, i) => {
          const hidden = this.hiddenSeries.has(s.name);
          return m(ChartLegend.Entry, {
            name: s.name,
            value: String(s.points.length),
            swatch: s.color ?? chartColorVar(i),
            hidden,
            onToggle: () => this.toggleSeries(s.name),
            onMouseEnter: hidden ? undefined : () => this.setHoveredSeries(i),
            onMouseLeave: hidden ? undefined : () => this.clearHoveredSeries(i),
          });
        }),
      );

    const multi = data !== undefined && data.series.length > 1;
    const tooltip =
      this.hover !== undefined &&
      m(ChartTooltip, [
        multi && m(ChartTooltip.Header, this.hover.seriesName),
        m(ChartTooltip.Row, {
          name: 'X',
          value: formatXValue(this.hover.x),
          swatch: this.hover.color,
        }),
        m(ChartTooltip.Row, {name: 'Y', value: formatYValue(this.hover.y)}),
        this.hover.label !== undefined &&
          m(ChartTooltip.Row, {name: 'Label', value: this.hover.label}),
      ]);

    return m(
      '.pf-chart-svg',
      {
        className: classNames(
          fillParent && 'pf-chart-svg--fill-parent',
          `pf-chart-svg--legend-${legendPosition}`,
          className,
        ),
        style: fillParent ? undefined : {height: `${height}px`},
      },
      m(SvgChartFrame, {
        isLoading,
        isEmpty,
        renderChart: (w, h) => this.renderChart(attrs, data!, w, h),
      }),
      legend,
      tooltip,
    );
  }

  private renderChart(
    attrs: ScatterChartAttrs,
    data: ScatterChartData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const fmtX = attrs.formatXValue ?? defaultFmt;
    const fmtY = attrs.formatYValue ?? defaultFmt;
    const logX = attrs.logScaleX ?? false;
    const logY = attrs.logScaleY ?? false;
    const scaleAxes = attrs.scaleAxes ?? false;
    const symbolSize = attrs.symbolSize ?? DEFAULT_SYMBOL_SIZE;
    const symbolSizeRange = attrs.symbolSizeRange ?? DEFAULT_SYMBOL_SIZE_RANGE;
    const gridLines = attrs.gridLines;
    const showHGrid = gridLines === 'horizontal' || gridLines === 'both';
    const showVGrid = gridLines === 'vertical' || gridLines === 'both';

    // Series toggled off via the legend are excluded from ranges and drawing.
    const visibleSeries = data.series.filter(
      (s) => !this.hiddenSeries.has(s.name),
    );

    // Bubble sizing: normalize per-point `.size` across every visible point
    // onto symbolSizeRange (diameters). Without sizes, all points share the
    // default radius.
    let minSize = Infinity;
    let maxSize = -Infinity;
    for (const s of visibleSeries) {
      for (const p of s.points) {
        if (p.size !== undefined) {
          if (p.size < minSize) minSize = p.size;
          if (p.size > maxSize) maxSize = p.size;
        }
      }
    }
    const hasSizes = minSize !== Infinity;
    const sizeSpan = maxSize - minSize || 1;
    const radiusFor = (size?: number): number => {
      if (!hasSizes || size === undefined) return symbolSize / 2;
      const norm = (size - minSize) / sizeSpan;
      const dia =
        symbolSizeRange[0] + norm * (symbolSizeRange[1] - symbolSizeRange[0]);
      return dia / 2;
    };

    // Build chart-space series, colouring by *original* data index so colours
    // stay stable when a series is toggled off.
    const seriesPlots: SeriesPlot[] = [];
    const allX: number[] = [];
    const allY: number[] = [];
    data.series.forEach((s, i) => {
      if (this.hiddenSeries.has(s.name)) return;
      const color = s.color ?? chartColorVar(i);
      const points = s.points.map((p) => {
        allX.push(p.x);
        allY.push(p.y);
        return {
          x: p.x,
          y: p.y,
          r: radiusFor(p.size),
          color: p.color ?? color,
          label: p.label,
        };
      });
      seriesPlots.push({name: s.name, color, points});
    });

    const xRange = computeAxisRange(allX, logX, scaleAxes);
    const yRange = computeAxisRange(allY, logY, scaleAxes);

    const xName = attrs.xAxisLabel;
    const yName = attrs.yAxisLabel;
    const layout = computePlotLayout({
      width,
      height,
      yLabels: yRange.ticks.map(fmtY),
      xName,
      yName,
    });
    const {padLeft, padTop, plotW, plotH} = layout;

    const g: Geom = {padLeft, padTop, plotW, plotH, xRange, yRange, logX, logY};
    const xPx = (x: number) => xToPx(x, g);
    const yPx = (y: number) => yToPx(y, g);

    const sel = attrs.selection;
    const inSelection = (p: PointPlot): boolean =>
      sel === undefined ||
      (p.x >= sel.xMin &&
        p.x <= sel.xMax &&
        p.y >= sel.yMin &&
        p.y <= sel.yMax);

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: attrs.onBrush && {cursor: 'crosshair'},
        oncontextmenu: (e: Event) => {
          // Chrome breaks pointer capture on right-click — disable the menu.
          e.preventDefault();
        },
        onpointerdown:
          attrs.onBrush && ((e: PointerEvent) => this.handleBrushDown(e, g)),
        onpointermove: (e: PointerEvent) =>
          this.handlePointerMove(e, seriesPlots, g),
        onpointerup:
          attrs.onBrush &&
          ((e: PointerEvent) => this.handleBrushUp(e, g, attrs.onBrush!)),
        onpointerleave: () => {
          if (this.brushing) return; // capture keeps the drag alive.
          if (this.hover !== undefined) {
            this.hover = undefined;
          }
        },
        onlostpointercapture: () => {
          // Pointer capture yanked (e.g. system gesture) — abandon the drag.
          this.brushing = undefined;
        },
      },
      // Clip data drawings to the plot area so points near the edge can't
      // bleed over the axes.
      m(
        'defs',
        m(
          'clipPath',
          {id: this.clipId},
          m('rect', {x: padLeft, y: padTop, width: plotW, height: plotH}),
        ),
      ),
      renderPlotFrame({
        layout,
        height,
        xName,
        yName,
        yTicks: yRange.ticks.map((t) => ({label: fmtY(t), y: yPx(t)})),
      }),
      // Gridlines (drawn before points so they sit underneath).
      showHGrid &&
        yRange.ticks.map((t) =>
          m('line', {
            className: 'pf-chart-svg__gridline',
            x1: padLeft,
            y1: yPx(t),
            x2: padLeft + plotW,
            y2: yPx(t),
            stroke: 'currentColor',
          }),
        ),
      showVGrid &&
        xRange.ticks.map((t) =>
          m('line', {
            className: 'pf-chart-svg__gridline',
            x1: xPx(t),
            y1: padTop,
            x2: xPx(t),
            y2: padTop + plotH,
            stroke: 'currentColor',
          }),
        ),
      // X ticks + labels along the bottom.
      xRange.ticks.map((t) =>
        m('g', [
          m('line', {
            className: 'pf-chart-svg__line',
            x1: xPx(t),
            y1: padTop + plotH,
            x2: xPx(t),
            y2: padTop + plotH + TICK_LENGTH,
            stroke: 'currentColor',
          }),
          m(
            'text',
            {
              'className': 'pf-chart-svg__tick-label',
              'x': xPx(t),
              'y': padTop + plotH + TICK_LENGTH + TICK_LABEL_GAP,
              'fill': 'currentColor',
              'text-anchor': 'middle',
              'dominant-baseline': 'hanging',
            },
            fmtX(t),
          ),
        ]),
      ),
      // Data drawings — clipped to the plot area.
      m('g', {'clip-path': `url(#${this.clipId})`}, [
        // Vertical highlight bands, drawn behind the points.
        (attrs.highlightBands ?? []).map((b) => {
          const bx0 = xPx(
            clamp(Math.min(b.start, b.end), xRange.min, xRange.max),
          );
          const bx1 = xPx(
            clamp(Math.max(b.start, b.end), xRange.min, xRange.max),
          );
          return m('rect', {
            'x': bx0,
            'y': padTop,
            'width': Math.max(0, bx1 - bx0),
            'height': plotH,
            'fill': b.color ?? HIGHLIGHT_BAND_COLOR,
            'pointer-events': 'none',
          });
        }),
        // Static selection overlay (driven by attrs.selection).
        sel !== undefined &&
          (() => {
            const x1 = xPx(clamp(sel.xMin, xRange.min, xRange.max));
            const x2 = xPx(clamp(sel.xMax, xRange.min, xRange.max));
            // yMax maps to the top edge, yMin to the bottom.
            const yTop = yPx(clamp(sel.yMax, yRange.min, yRange.max));
            const yBot = yPx(clamp(sel.yMin, yRange.min, yRange.max));
            return m('rect', {
              'className': 'pf-chart-svg__selection',
              'x': Math.min(x1, x2),
              'y': Math.min(yTop, yBot),
              'width': Math.abs(x2 - x1),
              'height': Math.abs(yBot - yTop),
              'fill': 'currentColor',
              'stroke': 'currentColor',
              'stroke-width': 1,
              'pointer-events': 'none',
            });
          })(),
        // Points, grouped per series so a legend hover can dim other series.
        seriesPlots.map((s, i) => {
          const seriesMuted =
            this.hoveredSeries !== undefined && this.hoveredSeries !== i;
          return m(
            'g',
            {'opacity': seriesMuted ? 0.25 : 1, 'pointer-events': 'none'},
            s.points.map((p) =>
              m('circle', {
                'cx': xPx(p.x),
                'cy': yPx(p.y),
                'r': p.r,
                'fill': p.color,
                'fill-opacity': inSelection(p) ? 0.75 : 0.12,
              }),
            ),
          );
        }),
        // Emphasize the hovered point with a ring.
        this.hover !== undefined &&
          m('circle', {
            'cx': xPx(this.hover.x),
            'cy': yPx(this.hover.y),
            'r': this.hover.r + 3,
            'fill': 'none',
            'stroke': this.hover.color,
            'stroke-width': 2,
            'pointer-events': 'none',
          }),
      ]),
      // Active brush drag rectangle (on top of everything else).
      this.brushing &&
        (() => {
          const x1 = xPx(clamp(this.brushing!.startX, xRange.min, xRange.max));
          const x2 = xPx(
            clamp(this.brushing!.currentX, xRange.min, xRange.max),
          );
          const y1 = yPx(clamp(this.brushing!.startY, yRange.min, yRange.max));
          const y2 = yPx(
            clamp(this.brushing!.currentY, yRange.min, yRange.max),
          );
          return m('rect', {
            'className': 'pf-chart-svg__brush',
            'x': Math.min(x1, x2),
            'y': Math.min(y1, y2),
            'width': Math.abs(x2 - x1),
            'height': Math.abs(y2 - y1),
            'fill': 'currentColor',
            'stroke': 'currentColor',
            'stroke-width': 1,
            'pointer-events': 'none',
          });
        })(),
    );
  }

  private handleBrushDown(e: PointerEvent, g: Geom) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const px = clamp(e.clientX - rect.left, g.padLeft, g.padLeft + g.plotW);
    const py = clamp(e.clientY - rect.top, g.padTop, g.padTop + g.plotH);
    const xv = pxToX(px, g);
    const yv = pxToY(py, g);
    // Capture the pointer so move/up fire on the SVG even if the cursor
    // leaves it. Capture is auto-released on pointerup.
    svg.setPointerCapture(e.pointerId);
    this.brushing = {
      startX: xv,
      startY: yv,
      currentX: xv,
      currentY: yv,
      pointerId: e.pointerId,
    };
    this.hover = undefined;
    e.preventDefault();
  }

  private handleBrushUp(
    e: PointerEvent,
    g: Geom,
    onBrush: (range: {
      xMin: number;
      xMax: number;
      yMin: number;
      yMax: number;
    }) => void,
  ) {
    if (!this.brushing || this.brushing.pointerId !== e.pointerId) return;
    const {startX, startY, currentX, currentY} = this.brushing;
    this.brushing = undefined;
    // Distinguish a drag from a bare click by pixel travel; a click must not
    // emit a selection.
    const dxPx = Math.abs(xToPx(startX, g) - xToPx(currentX, g));
    const dyPx = Math.abs(yToPx(startY, g) - yToPx(currentY, g));
    if (dxPx < DRAG_THRESHOLD_PX && dyPx < DRAG_THRESHOLD_PX) return;
    onBrush({
      xMin: Math.min(startX, currentX),
      xMax: Math.max(startX, currentX),
      yMin: Math.min(startY, currentY),
      yMax: Math.max(startY, currentY),
    });
  }

  private handlePointerMove(
    e: PointerEvent,
    seriesPlots: ReadonlyArray<SeriesPlot>,
    g: Geom,
  ) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    // While brushing, track the drag end (in data coords) and suppress the
    // hover tooltip — it gets in the way of seeing the selection.
    if (this.brushing && this.brushing.pointerId === e.pointerId) {
      const px = clamp(e.clientX - rect.left, g.padLeft, g.padLeft + g.plotW);
      const py = clamp(e.clientY - rect.top, g.padTop, g.padTop + g.plotH);
      this.brushing = {
        startX: this.brushing.startX,
        startY: this.brushing.startY,
        currentX: pxToX(px, g),
        currentY: pxToY(py, g),
        pointerId: e.pointerId,
      };
      this.hover = undefined;
      return;
    }
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (
      px < g.padLeft ||
      px > g.padLeft + g.plotW ||
      py < g.padTop ||
      py > g.padTop + g.plotH
    ) {
      if (this.hover !== undefined) this.hover = undefined;
      return;
    }
    // Nearest point under the cursor, within its radius plus a little slack.
    let best: HoverState | undefined;
    let bestDist = Infinity;
    for (const s of seriesPlots) {
      for (const p of s.points) {
        const dx = xToPx(p.x, g) - px;
        const dy = yToPx(p.y, g) - py;
        const dist = Math.hypot(dx, dy);
        if (dist <= p.r + HOVER_SLOP_PX && dist < bestDist) {
          bestDist = dist;
          best = {
            seriesName: s.name,
            color: p.color,
            r: p.r,
            x: p.x,
            y: p.y,
            label: p.label,
          };
        }
      }
    }
    this.hover = best;
  }
}

// Axis range over `vals`: log-snapped when `log`, exact data bounds when
// `scaleAxes`, otherwise a "nice" range fitted to the data.
function computeAxisRange(
  vals: ReadonlyArray<number>,
  log: boolean,
  scaleAxes: boolean,
): AxisRange {
  if (log) {
    const positive = vals.filter((v) => v > 0);
    return logRange(
      Math.max(min(positive) ?? NaN, 1e-9),
      Math.max(max(positive) ?? NaN, 1e-9),
    );
  }
  const lo = min(vals) ?? NaN;
  const hi = max(vals) ?? NaN;
  return scaleAxes ? rangeWithFixedBounds(lo, hi) : niceRange(lo, hi);
}

function xToPx(x: number, g: Geom): number {
  if (g.logX) {
    const v = x > 0 ? x : g.xRange.min;
    const num = Math.log10(v) - Math.log10(g.xRange.min);
    const den = Math.log10(g.xRange.max) - Math.log10(g.xRange.min) || 1;
    return g.padLeft + (num / den) * g.plotW;
  }
  return (
    g.padLeft +
    ((x - g.xRange.min) / (g.xRange.max - g.xRange.min || 1)) * g.plotW
  );
}

function yToPx(y: number, g: Geom): number {
  if (g.logY) {
    const v = y > 0 ? y : g.yRange.min;
    const num = Math.log10(v) - Math.log10(g.yRange.min);
    const den = Math.log10(g.yRange.max) - Math.log10(g.yRange.min) || 1;
    return g.padTop + g.plotH - (num / den) * g.plotH;
  }
  return (
    g.padTop +
    g.plotH -
    ((y - g.yRange.min) / (g.yRange.max - g.yRange.min || 1)) * g.plotH
  );
}

function pxToX(px: number, g: Geom): number {
  const frac = (px - g.padLeft) / (g.plotW || 1);
  if (g.logX) {
    const lo = Math.log10(g.xRange.min);
    const hi = Math.log10(g.xRange.max);
    return Math.pow(10, lo + frac * (hi - lo));
  }
  return g.xRange.min + frac * (g.xRange.max - g.xRange.min);
}

function pxToY(px: number, g: Geom): number {
  const frac = (g.padTop + g.plotH - px) / (g.plotH || 1);
  if (g.logY) {
    const lo = Math.log10(g.yRange.min);
    const hi = Math.log10(g.yRange.max);
    return Math.pow(10, lo + frac * (hi - lo));
  }
  return g.yRange.min + frac * (g.yRange.max - g.yRange.min);
}
