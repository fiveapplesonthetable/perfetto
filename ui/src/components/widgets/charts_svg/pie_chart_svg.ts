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
import type {
  PieChartAttrs,
  PieChartData,
  PieChartSlice,
} from '../charts/pie_chart';
import {AXIS_LABEL_FONT_SIZE, chartColorVar, defaultFmt} from './common';
import {ChartLegend} from './legend';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {
  PieChartAttrs,
  PieChartData,
  PieChartSlice,
} from '../charts/pie_chart';

const TWO_PI = Math.PI * 2;
// Padding between the chart edge and the pie's outer radius. Leaves room for
// the hover-emphasis bump so an emphasised slice can't clip the container.
const PAD = 12;
// Extra outer radius (px) added to the hovered slice.
const HOVER_EXTRA = 4;
// Slices thinner than this (percent of the total) don't get a % label — the
// text wouldn't fit inside the wedge.
const MIN_LABEL_PCT = 4;
// Slices are separated by a thin stroke in the container background colour so
// adjacent wedges read as distinct even when their fills are similar.
const SLICE_STROKE = 'var(--pf-color-background)';

// A wedge in chart-space: the source slice plus its angular extent measured
// clockwise from 12 o'clock.
interface Wedge {
  readonly slice: PieChartSlice;
  readonly index: number;
  readonly color: string;
  readonly a0: number;
  readonly a1: number;
}

export class PieChartSvg implements m.ClassComponent<PieChartAttrs> {
  // Original-slice index of the currently-hovered wedge, if any. Set both by
  // hovering a wedge and by hovering its legend entry.
  private hovered?: number;
  // Slices the user has toggled off via legend click, keyed by original index.
  private hidden = new Set<number>();

  private toggleSlice(i: number) {
    if (this.hidden.has(i)) {
      this.hidden.delete(i);
    } else {
      this.hidden.add(i);
    }
  }

  private setHovered(i: number) {
    if (this.hovered !== i) {
      this.hovered = i;
    }
  }

  private clearHovered(i: number) {
    if (this.hovered === i) {
      this.hovered = undefined;
    }
  }

  view({attrs}: m.Vnode<PieChartAttrs>) {
    const {
      data,
      height = 200,
      fillParent,
      className,
      formatValue = defaultFmt,
      showLegend = true,
      legendPosition = 'right',
    } = attrs;

    const isLoading = data === undefined;
    const slices = data?.slices ?? [];
    const isEmpty = data !== undefined && slices.length === 0;

    // Total over the visible (non-hidden, positive) slices — the denominator
    // for every percentage.
    const total = slices.reduce(
      (sum, s, i) => (this.hidden.has(i) || s.value <= 0 ? sum : sum + s.value),
      0,
    );

    const legend =
      showLegend &&
      data !== undefined &&
      slices.length > 0 &&
      m(
        ChartLegend,
        slices.map((s, i) => {
          const hidden = this.hidden.has(i);
          return m(ChartLegend.Entry, {
            name: s.label,
            value: formatValue(s.value),
            swatch: s.color ?? chartColorVar(i),
            hidden,
            onToggle: () => this.toggleSlice(i),
            onMouseEnter: hidden ? undefined : () => this.setHovered(i),
            onMouseLeave: hidden ? undefined : () => this.clearHovered(i),
          });
        }),
      );

    const tooltip = (() => {
      if (this.hovered === undefined || data === undefined) return false;
      const i = this.hovered;
      if (i < 0 || i >= slices.length || this.hidden.has(i)) return false;
      const s = slices[i];
      const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : '0';
      return m(ChartTooltip, [
        m(ChartTooltip.Header, s.label),
        m(ChartTooltip.Row, {
          name: 'Value',
          value: formatValue(s.value),
          swatch: s.color ?? chartColorVar(i),
        }),
        m(ChartTooltip.Row, {name: '%', value: `${pct}%`}),
      ]);
    })();

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
    attrs: PieChartAttrs,
    data: PieChartData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const showLabels = attrs.showLabels ?? false;
    const innerRatio = clamp(attrs.innerRadiusRatio ?? 0, 0, 0.95);

    const cx = width / 2;
    const cy = height / 2;
    const rOuter = Math.min(width, height) / 2 - PAD;
    const rInner = rOuter * innerRatio;
    if (rOuter <= 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    // Visible wedges only: hidden (legend-toggled) and non-positive slices are
    // excluded from both the total and the drawing.
    const visible = data.slices
      .map((slice, index) => ({
        slice,
        index,
        color: slice.color ?? chartColorVar(index),
      }))
      .filter((e) => e.slice.value > 0 && !this.hidden.has(e.index));
    const total = visible.reduce((sum, e) => sum + e.slice.value, 0);

    // Lay wedges out clockwise from 12 o'clock.
    const wedges: Wedge[] = [];
    let acc = 0;
    for (const e of visible) {
      const sweep = total > 0 ? (e.slice.value / total) * TWO_PI : 0;
      wedges.push({...e, a0: acc, a1: acc + sweep});
      acc += sweep;
    }

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      // Wedges.
      m(
        'g',
        wedges.map((wd) => {
          const isHovered = this.hovered === wd.index;
          const r = isHovered ? rOuter + HOVER_EXTRA : rOuter;
          return m('path', {
            'd': sectorPath(cx, cy, rInner, r, wd.a0, wd.a1),
            'fill': wd.color,
            'stroke': SLICE_STROKE,
            'stroke-width': 2,
            'stroke-linejoin': 'round',
            // Dim the non-hovered wedges to make the hovered one stand out.
            'opacity': this.hovered !== undefined && !isHovered ? 0.85 : 1,
            'style': attrs.onSliceClick && {cursor: 'pointer'},
            'onmouseenter': () => this.setHovered(wd.index),
            'onmouseleave': () => this.clearHovered(wd.index),
            'onclick':
              attrs.onSliceClick && (() => attrs.onSliceClick!(wd.slice)),
          });
        }),
      ),
      // Percentage labels (skip slivers that can't fit the text).
      showLabels &&
        m(
          'g',
          {'pointer-events': 'none'},
          wedges.map((wd) => {
            const pct = total > 0 ? (wd.slice.value / total) * 100 : 0;
            if (pct < MIN_LABEL_PCT) return undefined;
            const mid = (wd.a0 + wd.a1) / 2;
            const labelR = rInner > 0 ? (rInner + rOuter) / 2 : rOuter * 0.62;
            const [lx, ly] = polar(cx, cy, labelR, mid);
            return m(
              'text',
              {
                'x': lx,
                'y': ly,
                'fill': SLICE_STROKE,
                'font-size': AXIS_LABEL_FONT_SIZE,
                'text-anchor': 'middle',
                'dominant-baseline': 'middle',
              },
              `${pct.toFixed(0)}%`,
            );
          }),
        ),
    );
  }
}

// Point on the circle of radius `r` at `angle` measured clockwise from 12
// o'clock (SVG y grows downwards, hence the negated cosine).
function polar(
  cx: number,
  cy: number,
  r: number,
  angle: number,
): readonly [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

// Path for an annular sector (or a pie wedge when rInner === 0) spanning
// [a0, a1] clockwise. A full-circle span is split at its midpoint into two
// arcs because a single arc whose start and end points coincide degenerates
// to nothing.
function sectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  a0: number,
  a1: number,
): string {
  if (a1 - a0 >= TWO_PI - 1e-6) {
    const mid = a0 + Math.PI;
    return (
      sectorPath(cx, cy, rInner, rOuter, a0, mid) +
      ' ' +
      sectorPath(cx, cy, rInner, rOuter, mid, a1)
    );
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [ox0, oy0] = polar(cx, cy, rOuter, a0);
  const [ox1, oy1] = polar(cx, cy, rOuter, a1);
  if (rInner <= 0) {
    return (
      `M${cx},${cy} L${ox0},${oy0} ` +
      `A${rOuter},${rOuter} 0 ${large} 1 ${ox1},${oy1} Z`
    );
  }
  const [ix0, iy0] = polar(cx, cy, rInner, a0);
  const [ix1, iy1] = polar(cx, cy, rInner, a1);
  return (
    `M${ox0},${oy0} ` +
    `A${rOuter},${rOuter} 0 ${large} 1 ${ox1},${oy1} ` +
    `L${ix1},${iy1} ` +
    `A${rInner},${rInner} 0 ${large} 0 ${ix0},${iy0} Z`
  );
}
