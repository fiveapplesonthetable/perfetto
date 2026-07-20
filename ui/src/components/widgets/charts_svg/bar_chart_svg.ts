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
import type {BarChartAttrs, BarChartData} from '../charts/bar_chart';
import {
  AXIS_LABEL_FONT_SIZE,
  TICK_LABEL_GAP,
  TICK_LENGTH,
  chartColorVar,
  computePlotLayout,
  defaultFmt,
  estimateLabelWidth,
  logRange,
  niceRange,
  renderPlotFrame,
} from './common';
import {ChartLegend} from './legend';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {
  BarChartAttrs,
  BarChartData,
  BarChartItem,
  BarChartSeries,
} from '../charts/bar_chart';

// Fraction of a category band occupied by the bar; the remainder is the gap
// that keeps bars visually separated (histograms are gapless, bar charts are
// not).
const BAR_BAND_FRACTION = 0.7;
// Minimum pointer travel (px) along the category axis before a press is
// treated as a brush drag rather than a bare click.
const BRUSH_DRAG_THRESHOLD_PX = 3;

// One resolved series, keyed by the raw (unformatted) category label so the
// same lookup works whether categories came from `items` or `series`.
interface PlotSeries {
  readonly name: string;
  readonly color: string;
  readonly valueByLabel: ReadonlyMap<string | number, number>;
}

// A category (bar dimension) in draw order, with its formatted axis text.
interface PlotCategory {
  readonly label: string | number;
  readonly text: string;
}

interface ChartModel {
  readonly categories: ReadonlyArray<PlotCategory>;
  // Every series (for the legend, including toggled-off ones).
  readonly series: ReadonlyArray<PlotSeries>;
  // Series still visible after legend toggles (drives axes + bars).
  readonly visibleSeries: ReadonlyArray<PlotSeries>;
  readonly isMulti: boolean;
}

// One stacked segment of a bar, in value-axis fraction space [0, 1].
interface Segment {
  readonly name: string;
  readonly color: string;
  readonly value: number;
  readonly bottomFrac: number;
  readonly topFrac: number;
}

interface HoverState {
  readonly catIdx: number;
  readonly seriesName: string;
}

export class BarChartSvg implements m.ClassComponent<BarChartAttrs> {
  private hover?: HoverState;
  // Series emphasised via legend hover, keyed by name (dims the others).
  private hoveredSeriesName?: string;
  // Active brush drag, tracked in *category-index space* so a resize mid-drag
  // doesn't mangle the selection. `moved` distinguishes a real drag from a
  // bare click (which must not emit).
  private brushing?: {
    start: number;
    current: number;
    startPx: number;
    pointerId: number;
    moved: boolean;
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
  }

  private setHoveredSeries(name: string) {
    if (this.hoveredSeriesName !== name) {
      this.hoveredSeriesName = name;
    }
  }

  private clearHoveredSeries(name: string) {
    if (this.hoveredSeriesName === name) {
      this.hoveredSeriesName = undefined;
    }
  }

  view({attrs}: m.Vnode<BarChartAttrs>) {
    const {data} = attrs;
    const isLoading = data === undefined;
    const model =
      data !== undefined ? buildModel(attrs, this.hiddenSeries) : undefined;
    const isEmpty = model !== undefined && model.categories.length === 0;
    const legendPosition = attrs.legendPosition ?? 'top';

    const legend =
      model !== undefined &&
      model.isMulti &&
      m(
        ChartLegend,
        model.series.map((s) => {
          const hidden = this.hiddenSeries.has(s.name);
          return m(ChartLegend.Entry, {
            name: s.name,
            swatch: s.color,
            hidden,
            onToggle: () => this.toggleSeries(s.name),
            onMouseEnter: hidden
              ? undefined
              : () => this.setHoveredSeries(s.name),
            onMouseLeave: hidden
              ? undefined
              : () => this.clearHoveredSeries(s.name),
          });
        }),
      );

    const tooltip = (() => {
      if (this.hover === undefined || model === undefined) return false;
      const cat = model.categories[this.hover.catIdx];
      if (cat === undefined) return false;
      const fmtMeasure = attrs.formatMeasure ?? defaultFmt;
      return m(ChartTooltip, [
        m(ChartTooltip.Header, cat.text),
        model.visibleSeries.map((s) =>
          m(ChartTooltip.Row, {
            name: s.name,
            value: fmtMeasure(s.valueByLabel.get(cat.label) ?? 0),
            swatch: model.isMulti ? s.color : undefined,
            tweak: s.name === this.hover!.seriesName ? 'emphasis' : undefined,
          }),
        ),
      ]);
    })();

    return m(
      '.pf-chart-svg',
      {
        className: classNames(
          attrs.fillParent && 'pf-chart-svg--fill-parent',
          `pf-chart-svg--legend-${legendPosition}`,
          attrs.className,
        ),
        style: attrs.fillParent
          ? undefined
          : {height: `${attrs.height ?? 200}px`},
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
    attrs: BarChartAttrs,
    _data: BarChartData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const model = buildModel(attrs, this.hiddenSeries);
    const {categories, visibleSeries} = model;
    const n = categories.length;
    if (n === 0) return m('svg', {width, height});

    const horizontal = attrs.orientation === 'horizontal';
    const logScale = attrs.logScale ?? false;
    const integerMeasure = attrs.integerMeasure ?? false;
    const fmtMeasure = attrs.formatMeasure ?? defaultFmt;
    const barHoverColor = attrs.barHoverColor;
    const gridLines = attrs.gridLines;
    const showHGrid = gridLines === 'horizontal' || gridLines === 'both';
    const showVGrid = gridLines === 'vertical' || gridLines === 'both';

    // Value-axis range over per-category stack totals (visible series only,
    // so toggling a series off in the legend rescales the axis).
    const totals = categories.map((cat) => {
      let sum = 0;
      for (const s of visibleSeries) sum += s.valueByLabel.get(cat.label) ?? 0;
      return sum;
    });
    const maxValue = totals.length > 0 ? Math.max(...totals, 0) : 1;
    const valueRange = logScale
      ? logRange(1, Math.max(maxValue, 1))
      : niceRange(0, maxValue, {integer: integerMeasure});

    // Value → fraction [0, 1] along the value axis.
    const vMin = valueRange.min;
    const vMax = valueRange.max;
    const valueFrac = logScale
      ? (v: number) => {
          const vv = v > 0 ? v : vMin;
          const num = Math.log10(vv) - Math.log10(vMin);
          const den = Math.log10(vMax) - Math.log10(vMin) || 1;
          return clamp(num / den, 0, 1);
        }
      : (v: number) => clamp((v - vMin) / (vMax - vMin || 1), 0, 1);

    // Layout: whichever axis lands on the left dictates padLeft.
    const catTexts = categories.map((c) => c.text);
    const layout = computePlotLayout({
      width,
      height,
      yLabels: horizontal ? catTexts : valueRange.ticks.map(fmtMeasure),
      xName: horizontal ? attrs.measureLabel : attrs.dimensionLabel,
      yName: horizontal ? attrs.dimensionLabel : attrs.measureLabel,
    });
    const {padLeft, padTop, plotW, plotH} = layout;

    // Category (main) axis geometry. Bars grow along the cross (value) axis.
    const plotMain = horizontal ? plotH : plotW;
    const padMain = horizontal ? padTop : padLeft;
    const band = plotMain / n;
    const barSize = band * BAR_BAND_FRACTION;
    const catStart = (i: number) => padMain + band * i;
    const catCenter = (i: number) => padMain + band * i + band / 2;
    // Pixel position along the value axis for a given fraction.
    const valuePx = (frac: number) =>
      horizontal ? padLeft + frac * plotW : padTop + plotH - frac * plotH;

    // Pre-compute stacked segments per category (in fraction space).
    const bars = categories.map((cat) => {
      let cum = 0;
      const segments: Segment[] = visibleSeries.map((s) => {
        const value = s.valueByLabel.get(cat.label) ?? 0;
        const bottom = cum;
        cum += value;
        return {
          name: s.name,
          color: s.color,
          value,
          bottomFrac: valueFrac(bottom),
          topFrac: valueFrac(cum),
        };
      });
      return {segments};
    });

    // Category-label thinning + rotation. In vertical mode labels sit on the
    // bottom axis and may need rotating when they're wider than a band; in
    // horizontal mode they sit on the left axis with plenty of width and are
    // only thinned to avoid vertical overlap.
    const maxCatPx = estimateLabelWidth(catTexts);
    const rotate = !horizontal && maxCatPx > band;
    const perLabelPx = horizontal
      ? AXIS_LABEL_FONT_SIZE + 4
      : rotate
        ? AXIS_LABEL_FONT_SIZE + 6
        : maxCatPx + 6;
    const labelStep = Math.max(1, Math.ceil(perLabelPx / Math.max(1, band)));

    const selection = new Set(attrs.selection ?? []);

    // Hit-test helpers (used by the pointer handlers below).
    const hitCategory = (clientX: number, clientY: number, r: DOMRect) => {
      const main = (horizontal ? clientY - r.top : clientX - r.left) - padMain;
      if (main < 0 || main > plotMain) return -1;
      return clamp(Math.floor(main / band), 0, n - 1);
    };
    const crossFracAt = (clientX: number, clientY: number, r: DOMRect) =>
      horizontal
        ? clamp((clientX - r.left - padLeft) / (plotW || 1), 0, 1)
        : clamp((padTop + plotH - (clientY - r.top)) / (plotH || 1), 0, 1);
    const mainCoordAt = (clientX: number, clientY: number, r: DOMRect) =>
      horizontal ? clientY - r.top : clientX - r.left;

    const brush = this.brushing;

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
          ((e: PointerEvent) =>
            this.handleBrushDown(e, hitCategory, mainCoordAt)),
        onpointermove: (e: PointerEvent) =>
          this.handlePointerMove(
            e,
            hitCategory,
            crossFracAt,
            mainCoordAt,
            bars,
          ),
        onpointerup:
          attrs.onBrush &&
          ((e: PointerEvent) =>
            this.handleBrushUp(e, attrs.onBrush!, categories)),
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
      ),
      renderPlotFrame({
        layout,
        height,
        xName: horizontal ? attrs.measureLabel : attrs.dimensionLabel,
        yName: horizontal ? attrs.dimensionLabel : attrs.measureLabel,
        yTicks: horizontal
          ? categories.flatMap((cat, i) =>
              i % labelStep === 0 ? [{label: cat.text, y: catCenter(i)}] : [],
            )
          : valueRange.ticks.map((t) => ({
              label: fmtMeasure(t),
              y: valuePx(valueFrac(t)),
            })),
      }),
      // Gridlines, drawn before the bars so they sit underneath.
      showHGrid &&
        (horizontal
          ? categories.map((_, i) =>
              gridLine(padLeft, catCenter(i), padLeft + plotW, catCenter(i)),
            )
          : valueRange.ticks.map((t) =>
              gridLine(
                padLeft,
                valuePx(valueFrac(t)),
                padLeft + plotW,
                valuePx(valueFrac(t)),
              ),
            )),
      showVGrid &&
        (horizontal
          ? valueRange.ticks.map((t) =>
              gridLine(
                valuePx(valueFrac(t)),
                padTop,
                valuePx(valueFrac(t)),
                padTop + plotH,
              ),
            )
          : categories.map((_, i) =>
              gridLine(catCenter(i), padTop, catCenter(i), padTop + plotH),
            )),
      // Selection band backgrounds behind the bars.
      m(
        'g',
        {'pointer-events': 'none'},
        categories.map((cat, i) => {
          if (!selection.has(cat.label)) return undefined;
          return m('rect', {
            'className': 'pf-chart-svg__selection',
            'x': horizontal ? padLeft : catStart(i),
            'y': horizontal ? catStart(i) : padTop,
            'width': horizontal ? plotW : band,
            'height': horizontal ? band : plotH,
            'fill': 'currentColor',
            'stroke': 'currentColor',
            'stroke-width': 1,
          });
        }),
      ),
      // Bars (stacked segments), clipped to the plot area.
      m(
        'g',
        {'clip-path': `url(#${this.clipId})`, 'shape-rendering': 'crispEdges'},
        bars.map((bar, ci) =>
          bar.segments.map((seg) => {
            const isHover =
              this.hover?.catIdx === ci && this.hover?.seriesName === seg.name;
            const muted =
              this.hoveredSeriesName !== undefined &&
              seg.name !== this.hoveredSeriesName;
            const fill = isHover && barHoverColor ? barHoverColor : seg.color;
            const lo = valuePx(seg.bottomFrac);
            const hi = valuePx(seg.topFrac);
            return m('rect', {
              'x': horizontal
                ? Math.min(lo, hi)
                : catStart(ci) + (band - barSize) / 2,
              'y': horizontal
                ? catStart(ci) + (band - barSize) / 2
                : Math.min(lo, hi),
              'width': horizontal ? Math.abs(hi - lo) : barSize,
              'height': horizontal ? barSize : Math.abs(hi - lo),
              fill,
              'opacity': muted ? 0.4 : 1,
              'style': isHover &&
                !barHoverColor && {filter: 'brightness(1.15)'},
              'pointer-events': 'none',
            });
          }),
        ),
      ),
      // Category ticks (vertical) or value ticks (horizontal) on the bottom
      // axis. The left axis is handled by renderPlotFrame above.
      horizontal
        ? valueRange.ticks.map((t) => {
            const x = valuePx(valueFrac(t));
            return bottomTick(x, padTop + plotH, fmtMeasure(t), false);
          })
        : categories.map((cat, i) => {
            if (i % labelStep !== 0) return undefined;
            return bottomTick(catCenter(i), padTop + plotH, cat.text, rotate);
          }),
      // Live brush rectangle spanning the dragged category range.
      brush &&
        (() => {
          const lo = Math.min(brush.start, brush.current);
          const hi = Math.max(brush.start, brush.current);
          const a = catStart(lo);
          const len = band * (hi - lo + 1);
          return m('rect', {
            'className': 'pf-chart-svg__brush',
            'x': horizontal ? padLeft : a,
            'y': horizontal ? a : padTop,
            'width': horizontal ? plotW : len,
            'height': horizontal ? len : plotH,
            'fill': 'currentColor',
            'stroke': 'currentColor',
            'stroke-width': 1,
            'pointer-events': 'none',
          });
        })(),
    );
  }

  private handleBrushDown(
    e: PointerEvent,
    hitCategory: (clientX: number, clientY: number, r: DOMRect) => number,
    mainCoordAt: (clientX: number, clientY: number, r: DOMRect) => number,
  ) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const cat = hitCategory(e.clientX, e.clientY, rect);
    if (cat < 0) return;
    svg.setPointerCapture(e.pointerId);
    this.brushing = {
      start: cat,
      current: cat,
      startPx: mainCoordAt(e.clientX, e.clientY, rect),
      pointerId: e.pointerId,
      moved: false,
    };
    this.hover = undefined;
    e.preventDefault();
  }

  private handleBrushUp(
    e: PointerEvent,
    onBrush: (labels: Array<string | number>) => void,
    categories: ReadonlyArray<PlotCategory>,
  ) {
    if (!this.brushing || this.brushing.pointerId !== e.pointerId) return;
    const {start, current, moved} = this.brushing;
    this.brushing = undefined;
    // A press without meaningful travel is a click, not a range select.
    if (!moved) return;
    const lo = Math.min(start, current);
    const hi = Math.max(start, current);
    const labels: Array<string | number> = [];
    for (let i = lo; i <= hi; i++) labels.push(categories[i].label);
    if (labels.length > 0) onBrush(labels);
  }

  private handlePointerMove(
    e: PointerEvent,
    hitCategory: (clientX: number, clientY: number, r: DOMRect) => number,
    crossFracAt: (clientX: number, clientY: number, r: DOMRect) => number,
    mainCoordAt: (clientX: number, clientY: number, r: DOMRect) => number,
    bars: ReadonlyArray<{segments: ReadonlyArray<Segment>}>,
  ) {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (this.brushing && this.brushing.pointerId === e.pointerId) {
      const cat = hitCategory(e.clientX, e.clientY, rect);
      if (cat >= 0) this.brushing.current = cat;
      const px = mainCoordAt(e.clientX, e.clientY, rect);
      if (Math.abs(px - this.brushing.startPx) > BRUSH_DRAG_THRESHOLD_PX) {
        this.brushing.moved = true;
      }
      this.hover = undefined;
      return;
    }
    const cat = hitCategory(e.clientX, e.clientY, rect);
    if (cat < 0) {
      if (this.hover !== undefined) this.hover = undefined;
      return;
    }
    // Pick the stacked segment under the cursor; fall back to the top-most
    // segment when the cursor is above the stack.
    const segs = bars[cat].segments;
    const frac = crossFracAt(e.clientX, e.clientY, rect);
    let seriesName = segs.length > 0 ? segs[segs.length - 1].name : '';
    for (const s of segs) {
      if (frac >= s.bottomFrac && frac <= s.topFrac) {
        seriesName = s.name;
        break;
      }
    }
    if (this.hover?.catIdx !== cat || this.hover?.seriesName !== seriesName) {
      this.hover = {catIdx: cat, seriesName};
    }
  }
}

// Resolve attrs into an orientation-agnostic model: an ordered category list
// and one series per stack layer (a synthetic single series when only
// `items` are given). Categories are keyed by their raw label so lookups
// survive formatting.
function buildModel(attrs: BarChartAttrs, hidden: Set<string>): ChartModel {
  const data = attrs.data!;
  const fmtDimension =
    attrs.formatDimension ?? ((v: string | number) => String(v));
  const isMulti = data.series !== undefined && data.series.length > 0;

  const categories: PlotCategory[] = [];
  const seen = new Set<string | number>();
  const pushCat = (label: string | number) => {
    if (!seen.has(label)) {
      seen.add(label);
      categories.push({label, text: fmtDimension(label)});
    }
  };

  let series: PlotSeries[];
  if (isMulti) {
    series = data.series!.map((s, i) => {
      const valueByLabel = new Map<string | number, number>();
      for (const item of s.items) {
        valueByLabel.set(item.label, item.value);
        pushCat(item.label);
      }
      return {name: s.name, color: chartColorVar(i), valueByLabel};
    });
  } else {
    const valueByLabel = new Map<string | number, number>();
    for (const item of data.items) {
      valueByLabel.set(item.label, item.value);
      pushCat(item.label);
    }
    series = [
      {
        name: attrs.measureLabel ?? 'Value',
        color: attrs.barColor ?? chartColorVar(0),
        valueByLabel,
      },
    ];
  }

  const visibleSeries = isMulti
    ? series.filter((s) => !hidden.has(s.name))
    : series;
  return {categories, series, visibleSeries, isMulti};
}

function gridLine(x1: number, y1: number, x2: number, y2: number): m.Child {
  return m('line', {
    className: 'pf-chart-svg__gridline',
    x1,
    y1,
    x2,
    y2,
    stroke: 'currentColor',
  });
}

// A bottom-axis tick: a short mark plus its label. When `rotate` is set the
// label is drawn at -45° (used for dense/wide category labels).
function bottomTick(
  x: number,
  baselineY: number,
  label: string,
  rotate: boolean,
): m.Child {
  const y = baselineY + TICK_LENGTH + TICK_LABEL_GAP;
  return m('g', [
    m('line', {
      className: 'pf-chart-svg__line',
      x1: x,
      y1: baselineY,
      x2: x,
      y2: baselineY + TICK_LENGTH,
      stroke: 'currentColor',
    }),
    m(
      'text',
      {
        'className': 'pf-chart-svg__tick-label',
        'x': x,
        'y': y,
        'fill': 'currentColor',
        'text-anchor': rotate ? 'end' : 'middle',
        'dominant-baseline': rotate ? 'middle' : 'hanging',
        'transform': rotate ? `rotate(-45 ${x} ${y})` : undefined,
      },
      label,
    ),
  ]);
}
