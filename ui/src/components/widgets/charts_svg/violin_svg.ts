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
import {shortUuid} from '../../../base/uuid';
import {
  TICK_LABEL_GAP,
  TICK_LENGTH,
  chartColorVar,
  computePlotLayout,
  defaultFmt,
  niceRange,
  pointMarker,
  renderPlotFrame,
} from './common';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

// Raw samples for one category, drawn as a single mirrored violin.
export interface ViolinGroup {
  readonly label: string;
  readonly values: readonly number[];
}

export interface ViolinData {
  readonly groups: readonly ViolinGroup[];
}

export interface ViolinAttrs {
  readonly data: ViolinData | undefined;
  readonly height?: number;
  readonly fillParent?: boolean;
  readonly className?: string;
  // Category (x) axis name.
  readonly categoryLabel?: string;
  // Value (y) axis name.
  readonly valueLabel?: string;
  // Value formatter for tick labels and the tooltip. Defaults to defaultFmt.
  readonly formatValue?: (value: number) => string;
  readonly gridLines?: 'horizontal' | 'vertical' | 'both';
}

// Violin body occupies at most this fraction of its band on each side, so the
// widest point of two adjacent violins never quite touches.
const HALF_BAND_FRACTION = 0.45;
// Number of points the KDE is evaluated at across each group's range.
const KDE_SAMPLES = 40;
// Width of the inner IQR bar as a fraction of the band.
const IQR_BAR_FRACTION = 0.12;
// Fill opacity of the violin body; bumped up while hovered.
const BODY_FILL_OPACITY = 0.55;
const BODY_FILL_OPACITY_HOVERED = 0.7;
// Opacity of non-hovered violins once one is emphasised.
const BODY_OPACITY_MUTED = 0.4;

interface HoverState {
  readonly index: number;
}

// Five-number summary of a group's samples.
interface GroupStats {
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly max: number;
}

// One sample of the KDE curve: a value and its un-normalised density.
interface DensityPoint {
  readonly value: number;
  readonly density: number;
}

// A group resolved into everything the renderer needs: its summary, plus the
// KDE curve sampled across the value range.
interface ViolinPlot {
  readonly label: string;
  readonly stats: GroupStats;
  readonly curve: ReadonlyArray<DensityPoint>;
  readonly peakDensity: number;
}

export class ViolinSvg implements m.ClassComponent<ViolinAttrs> {
  private hover?: HoverState;
  private readonly clipId = `pf-chart-clip-${shortUuid()}`;

  view({attrs}: m.Vnode<ViolinAttrs>) {
    const {data} = attrs;
    const isLoading = data === undefined;
    const isEmpty =
      data !== undefined &&
      (data.groups.length === 0 ||
        data.groups.every((g) => g.values.length === 0));

    const tooltip = (() => {
      if (this.hover === undefined || data === undefined) return false;
      const group = data.groups[this.hover.index];
      if (group === undefined || group.values.length === 0) return false;
      const fmt = attrs.formatValue ?? defaultFmt;
      const s = computeStats(group.values);
      return m(ChartTooltip, [
        m(ChartTooltip.Header, group.label),
        m(ChartTooltip.Row, {name: 'Max', value: fmt(s.max)}),
        m(ChartTooltip.Row, {name: 'Q3', value: fmt(s.q3)}),
        m(ChartTooltip.Row, {name: 'Median', value: fmt(s.median)}),
        m(ChartTooltip.Row, {name: 'Q1', value: fmt(s.q1)}),
        m(ChartTooltip.Row, {name: 'Min', value: fmt(s.min)}),
      ]);
    })();

    return m(
      '.pf-chart-svg',
      {
        className: classNames(
          attrs.fillParent && 'pf-chart-svg--fill-parent',
          'pf-chart-svg--legend-top',
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
      tooltip,
    );
  }

  private renderChart(
    attrs: ViolinAttrs,
    data: ViolinData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const fmt = attrs.formatValue ?? defaultFmt;
    const gridLines = attrs.gridLines;
    const showHGrid = gridLines === 'horizontal' || gridLines === 'both';
    const showVGrid = gridLines === 'vertical' || gridLines === 'both';

    // Groups with no samples still occupy a band (so the axis stays aligned)
    // but contribute nothing to the value range or the drawn geometry.
    const plots: ReadonlyArray<ViolinPlot | undefined> = data.groups.map((g) =>
      g.values.length === 0 ? undefined : buildViolinPlot(g),
    );
    const n = plots.length;

    // Value axis spans every group's KDE support (which reaches its min..max).
    const allVals: number[] = [];
    for (const p of plots) {
      if (p === undefined) continue;
      for (const pt of p.curve) allVals.push(pt.value);
    }
    const vRange = niceRange(min(allVals) ?? 0, max(allVals) ?? 1);

    const xName = attrs.categoryLabel;
    const yName = attrs.valueLabel;
    const layout = computePlotLayout({
      width,
      height,
      yLabels: vRange.ticks.map(fmt),
      xName,
      yName,
    });
    const {padLeft, padTop, plotW, plotH} = layout;

    // Category band geometry runs along X; each violin is centred in its band.
    const bandW = n > 0 ? plotW / n : 0;
    const bandCenter = (i: number) => padLeft + (i + 0.5) * bandW;
    const halfMax = bandW * HALF_BAND_FRACTION;
    const iqrBarW = bandW * IQR_BAR_FRACTION;

    // Value -> pixel. Y grows downward so the max sits at the top.
    const span = vRange.max - vRange.min || 1;
    const valToPx = (v: number) =>
      padTop + plotH - ((v - vRange.min) / span) * plotH;

    // Category labels are thinned — and rotated when the band is too narrow —
    // to keep them from overlapping.
    const labelPx = Math.max(1, ...data.groups.map((g) => g.label.length)) * 6;
    const rotate = labelPx > bandW - 6;
    const need = rotate ? 14 : labelPx + 6;
    const labelStep = Math.max(1, Math.ceil(need / Math.max(1, bandW)));

    const hitTest = (clientX: number, rect: DOMRect) => {
      const pos = clientX - rect.left - padLeft;
      if (pos < 0 || pos > plotW) return -1;
      const i = Math.floor(pos / (bandW || 1));
      return i >= 0 && i < n ? i : -1;
    };

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        oncontextmenu: (e: Event) => e.preventDefault(),
        onpointermove: (e: PointerEvent) => {
          const rect = (
            e.currentTarget as SVGSVGElement
          ).getBoundingClientRect();
          const i = hitTest(e.clientX, rect);
          const idx = i < 0 ? undefined : i;
          if (this.hover?.index !== idx) {
            this.hover = idx === undefined ? undefined : {index: idx};
          }
        },
        onpointerleave: () => {
          if (this.hover !== undefined) this.hover = undefined;
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
        xName,
        yName,
        yTicks: vRange.ticks.map((t) => ({label: fmt(t), y: valToPx(t)})),
      }),
      // Gridlines (drawn before the violins so they sit underneath).
      showHGrid &&
        vRange.ticks.map((t) =>
          gridLine(padLeft, valToPx(t), padLeft + plotW, valToPx(t)),
        ),
      showVGrid &&
        plots.map((_, i) =>
          gridLine(bandCenter(i), padTop, bandCenter(i), padTop + plotH),
        ),
      // Violins, clipped to the plot area.
      m(
        'g',
        {'clip-path': `url(#${this.clipId})`},
        plots.map((p, i) =>
          p === undefined
            ? undefined
            : this.renderViolin(p, i, bandCenter(i), halfMax, iqrBarW, valToPx),
        ),
      ),
      // Category ticks + labels along the bottom.
      data.groups.map((g, i) => {
        if (i % labelStep !== 0) return undefined;
        const x = bandCenter(i);
        return m('g', [
          m('line', {
            className: 'pf-chart-svg__line',
            x1: x,
            y1: padTop + plotH,
            x2: x,
            y2: padTop + plotH + TICK_LENGTH,
            stroke: 'currentColor',
          }),
          m(
            'text',
            {
              'className': 'pf-chart-svg__tick-label',
              'x': x,
              'y': padTop + plotH + TICK_LENGTH + TICK_LABEL_GAP,
              'fill': 'currentColor',
              'text-anchor': rotate ? 'end' : 'middle',
              'dominant-baseline': rotate ? 'middle' : 'hanging',
              'transform': rotate
                ? `rotate(-30 ${x} ${padTop + plotH + TICK_LENGTH + TICK_LABEL_GAP})`
                : undefined,
            },
            g.label,
          ),
        ]);
      }),
    );
  }

  // Draw one mirrored violin: the filled density body, then the min..max
  // whisker, the q1..q3 IQR bar and the median dot down the band centre.
  private renderViolin(
    plot: ViolinPlot,
    index: number,
    center: number,
    halfMax: number,
    iqrBarW: number,
    valToPx: (v: number) => number,
  ): m.Children {
    const color = chartColorVar(index);
    const hovered = this.hover?.index === index;
    const muted = this.hover !== undefined && !hovered;
    const {stats} = plot;

    // Un-normalised density -> half-width in pixels; the peak reaches halfMax.
    const halfWidth = (density: number) =>
      plot.peakDensity > 0 ? (density / plot.peakDensity) * halfMax : 0;

    return m(
      'g',
      {'pointer-events': 'none', 'opacity': muted ? BODY_OPACITY_MUTED : 1},
      // Density body.
      m('path', {
        'd': violinPath(plot.curve, center, halfWidth, valToPx),
        'fill': color,
        'fill-opacity': hovered ? BODY_FILL_OPACITY_HOVERED : BODY_FILL_OPACITY,
        'stroke': color,
        'stroke-width': hovered ? 2 : 1,
      }),
      // Whisker: a thin line from min to max.
      m('line', {
        'x1': center,
        'y1': valToPx(stats.min),
        'x2': center,
        'y2': valToPx(stats.max),
        'stroke': 'currentColor',
        'stroke-width': 1,
      }),
      // IQR bar spanning q1..q3.
      m('rect', {
        x: center - iqrBarW / 2,
        y: valToPx(stats.q3),
        width: iqrBarW,
        height: Math.abs(valToPx(stats.q1) - valToPx(stats.q3)),
        fill: 'currentColor',
      }),
      // Median dot.
      pointMarker(center, valToPx(stats.median), color, 2.5),
    );
  }
}

// Build the closed, mirrored violin outline: the density curve up the right of
// the band centre, then its mirror back down the left.
function violinPath(
  curve: ReadonlyArray<DensityPoint>,
  center: number,
  halfWidth: (density: number) => number,
  valToPx: (v: number) => number,
): string {
  if (curve.length === 0) return '';
  let d = '';
  for (let i = 0; i < curve.length; i++) {
    const x = center + halfWidth(curve[i].density);
    const y = valToPx(curve[i].value);
    d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  }
  for (let i = curve.length - 1; i >= 0; i--) {
    const x = center - halfWidth(curve[i].density);
    const y = valToPx(curve[i].value);
    d += 'L' + x + ',' + y + ' ';
  }
  return d + 'Z';
}

function buildViolinPlot(group: ViolinGroup): ViolinPlot {
  const sorted = group.values
    .filter(isFinite)
    .slice()
    .sort((a, b) => a - b);
  const stats = statsFromSorted(sorted);
  const curve = kde(sorted);
  let peakDensity = 0;
  for (const pt of curve) {
    if (pt.density > peakDensity) peakDensity = pt.density;
  }
  return {label: group.label, stats, curve, peakDensity};
}

// Gaussian kernel-density estimate sampled at KDE_SAMPLES points across the
// data range, with a Silverman's-rule bandwidth.
function kde(sorted: ReadonlyArray<number>): ReadonlyArray<DensityPoint> {
  const n = sorted.length;
  if (n === 0) return [];
  const lo = sorted[0];
  const hi = sorted[n - 1];
  const h = silvermanBandwidth(sorted);
  const invNH = 1 / (n * h);
  const points: DensityPoint[] = [];
  for (let k = 0; k < KDE_SAMPLES; k++) {
    const value = lo + ((hi - lo) * k) / (KDE_SAMPLES - 1);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += gaussian((value - sorted[i]) / h);
    points.push({value, density: sum * invNH});
  }
  return points;
}

// Standard normal density, the KDE kernel.
function gaussian(u: number): number {
  return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
}

// Silverman's rule of thumb: h = 0.9 * A * n^(-1/5), where A is the more
// robust of the standard deviation and IQR/1.349. Guards a zero spread so the
// kernel width never collapses to zero.
function silvermanBandwidth(sorted: ReadonlyArray<number>): number {
  const n = sorted.length;
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / n;
  let variance = 0;
  for (const v of sorted) variance += (v - mean) * (v - mean);
  const std = Math.sqrt(variance / n);
  const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);
  const a = iqr > 0 ? Math.min(std, iqr / 1.349) : std;
  const spread = a > 0 ? a : std > 0 ? std : 1;
  return 0.9 * spread * Math.pow(n, -1 / 5);
}

// Linear-interpolated percentile of an ascending-sorted array; p in [0, 1].
function percentile(sorted: ReadonlyArray<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function statsFromSorted(sorted: ReadonlyArray<number>): GroupStats {
  return {
    min: sorted[0],
    q1: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    q3: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

// Convenience for callers that only need the five-number summary (e.g. the
// tooltip) without the full KDE.
function computeStats(values: readonly number[]): GroupStats {
  return statsFromSorted(
    values
      .filter(isFinite)
      .slice()
      .sort((a, b) => a - b),
  );
}

function gridLine(x1: number, y1: number, x2: number, y2: number): m.Children {
  return m('line', {
    className: 'pf-chart-svg__gridline',
    x1,
    y1,
    x2,
    y2,
    stroke: 'currentColor',
  });
}
