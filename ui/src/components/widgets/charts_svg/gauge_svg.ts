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
import type {GaugeAttrs} from '../charts/gauge';
import type {SingleValueData} from '../charts/single_value_loader';
import {AXIS_LABEL_FONT_SIZE, defaultFmt} from './common';
import {SvgChartFrame} from './svg_chart_frame';

export type {GaugeAttrs} from '../charts/gauge';

// Radial thickness (px) of the track + progress annulus.
const TRACK_WIDTH = 18;
// The arc sweeps clockwise from 225° (bottom-left) to -45° (bottom-right),
// measured math-style (counter-clockwise from 3 o'clock), leaving a 90° gap
// at the bottom for the value + label text.
const START_ANGLE = 225;
const END_ANGLE = -45;
const SWEEP = START_ANGLE - END_ANGLE; // 270°
// Length (px) of the axis tick marks, drawn just inside the track.
const TICK_LENGTH = 6;
// Gap (px) between a tick mark and its numeric label.
const TICK_LABEL_GAP = 6;
// Fractions of the range at which ticks + labels are drawn.
const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
// Track colour: a muted annulus the progress arc is drawn over.
const TRACK_COLOR = 'var(--pf-color-border)';
// Progress + pointer colour.
const PROGRESS_COLOR = 'var(--pf-chart-color-1)';

export class GaugeSvg implements m.ClassComponent<GaugeAttrs> {
  view({attrs}: m.Vnode<GaugeAttrs>) {
    const {data, isPending, height = 300, fillParent} = attrs;

    // The gauge is never "empty" — a missing value simply reads as loading.
    const isLoading = isPending || data === undefined;

    return m(
      '.pf-chart-svg',
      {
        className: classNames(fillParent && 'pf-chart-svg--fill-parent'),
        style: fillParent ? undefined : {height: `${height}px`},
      },
      m(SvgChartFrame, {
        isLoading,
        isEmpty: false,
        renderChart: (w, h) => this.renderChart(attrs, data!, w, h),
      }),
    );
  }

  private renderChart(
    attrs: GaugeAttrs,
    data: SingleValueData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const min = attrs.min ?? 0;
    const max = attrs.max ?? 100;
    const formatValue = attrs.formatValue ?? defaultFmt;
    const diameter = parseDiameter(attrs.diameter ?? '75%');

    const value = data.value;
    const span = max - min || 1;
    const frac = clamp((value - min) / span, 0, 1);
    const valueAngle = START_ANGLE - frac * SWEEP;

    const cx = width / 2;
    // Centre a bit high so the value + label text has room to sit below the
    // 270° arc's bottom gap.
    const cy = height * 0.45;
    const rOuter = diameter * (Math.min(width, height) / 2);
    const rInner = Math.max(0, rOuter - TRACK_WIDTH);
    if (rOuter <= 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    // Font sizes scale with the gauge so small containers stay legible.
    const valueFontSize = clamp(rOuter * 0.3, 14, 40);
    const labelFontSize = clamp(rOuter * 0.12, 10, 16);
    const tickR = rInner - TICK_LENGTH - TICK_LABEL_GAP;

    return m(
      'svg.pf-chart-svg__svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      // Background track (full sweep).
      m('path', {
        d: annularArcPath(cx, cy, rInner, rOuter, START_ANGLE, END_ANGLE),
        fill: TRACK_COLOR,
      }),
      // Progress arc, from the start angle to the value angle.
      frac > 0 &&
        m('path', {
          d: annularArcPath(cx, cy, rInner, rOuter, START_ANGLE, valueAngle),
          fill: PROGRESS_COLOR,
        }),
      // Tick marks + numeric labels at 0/25/50/75/100% of the range.
      m(
        'g',
        {'pointer-events': 'none'},
        TICK_FRACTIONS.map((f) => {
          const angle = START_ANGLE - f * SWEEP;
          const [x0, y0] = polar(cx, cy, rInner, angle);
          const [x1, y1] = polar(cx, cy, rInner - TICK_LENGTH, angle);
          const [lx, ly] = polar(cx, cy, tickR, angle);
          return m('g', [
            m('line', {
              className: 'pf-chart-svg__line',
              x1: x0,
              y1: y0,
              x2: x1,
              y2: y1,
              stroke: 'currentColor',
            }),
            m(
              'text',
              {
                'className': 'pf-chart-svg__tick-label',
                'x': lx,
                'y': ly,
                'fill': 'currentColor',
                'font-size': AXIS_LABEL_FONT_SIZE,
                'text-anchor': 'middle',
                'dominant-baseline': 'middle',
              },
              defaultFmt(min + f * span),
            ),
          ]);
        }),
      ),
      // Needle from the centre to the value angle.
      (() => {
        const [nx, ny] = polar(cx, cy, rInner * 0.92, valueAngle);
        return m('line', {
          'x1': cx,
          'y1': cy,
          'x2': nx,
          'y2': ny,
          'stroke': PROGRESS_COLOR,
          'stroke-width': 3,
          'stroke-linecap': 'round',
        });
      })(),
      // Centre hub.
      m('circle', {
        cx,
        cy,
        r: Math.max(4, rOuter * 0.06),
        fill: PROGRESS_COLOR,
      }),
      // Big bold value, below the centre.
      m(
        'text',
        {
          'x': cx,
          'y': cy + rOuter * 0.6,
          'fill': 'currentColor',
          'font-size': valueFontSize,
          'font-weight': 700,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
        },
        formatValue(value),
      ),
      // Caption under the value.
      m(
        'text',
        {
          'className': 'pf-chart-svg__axis-title',
          'x': cx,
          'y': cy + rOuter * 0.6 + valueFontSize * 0.75 + labelFontSize,
          'fill': 'currentColor',
          'font-size': labelFontSize,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
        },
        attrs.label,
      ),
    );
  }
}

// Parse a CSS-ish percentage (e.g. '75%') into a 0..1 fraction of min(w,h)/2.
function parseDiameter(diameter: string): number {
  const n = parseFloat(diameter);
  if (!isFinite(n)) return 0.75;
  return clamp(n / 100, 0, 1);
}

// Point on the circle of radius `r` at `deg` measured counter-clockwise from
// 3 o'clock (SVG y grows downwards, hence the negated sine).
function polar(
  cx: number,
  cy: number,
  r: number,
  deg: number,
): readonly [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}

// Path for an annular band spanning [startDeg, endDeg] clockwise (startDeg >
// endDeg). The outer edge is traced clockwise, then the inner edge back.
function annularArcPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const large = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
  const [ox0, oy0] = polar(cx, cy, rOuter, startDeg);
  const [ox1, oy1] = polar(cx, cy, rOuter, endDeg);
  const [ix1, iy1] = polar(cx, cy, rInner, endDeg);
  const [ix0, iy0] = polar(cx, cy, rInner, startDeg);
  return (
    `M${ox0},${oy0} ` +
    `A${rOuter},${rOuter} 0 ${large} 1 ${ox1},${oy1} ` +
    `L${ix1},${iy1} ` +
    `A${rInner},${rInner} 0 ${large} 0 ${ix0},${iy0} Z`
  );
}
