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
import type {BoxplotAttrs, BoxplotData, BoxplotItem} from '../charts/boxplot';
import {
  TICK_LABEL_GAP,
  TICK_LENGTH,
  chartColorVar,
  computePlotLayout,
  defaultFmt,
  niceRange,
  renderPlotFrame,
} from './common';
import {SvgChartFrame} from './svg_chart_frame';
import {ChartTooltip} from './tooltip';

export type {BoxplotAttrs, BoxplotData, BoxplotItem} from '../charts/boxplot';

// Box occupies this fraction of its category band; the rest is inter-box gap.
const BOX_BAND_FRACTION = 0.6;
// Whisker caps span this fraction of the box width.
const CAP_BOX_FRACTION = 0.5;
// Fill opacity of the IQR box; bumped up while hovered.
const BOX_FILL_OPACITY = 0.35;
const BOX_FILL_OPACITY_HOVERED = 0.55;

interface HoverState {
  readonly index: number;
}

export class BoxplotSvg implements m.ClassComponent<BoxplotAttrs> {
  private hover?: HoverState;
  private readonly clipId = `pf-chart-clip-${shortUuid()}`;

  view({attrs}: m.Vnode<BoxplotAttrs>) {
    const {data} = attrs;
    const isLoading = data === undefined;
    const isEmpty = data !== undefined && data.items.length === 0;

    const tooltip = (() => {
      if (this.hover === undefined || data === undefined) return false;
      const item = data.items[this.hover.index];
      if (item === undefined) return false;
      const fmt = attrs.formatValue ?? defaultFmt;
      return m(ChartTooltip, [
        m(ChartTooltip.Header, item.label),
        m(ChartTooltip.Row, {name: 'Max', value: fmt(item.max)}),
        m(ChartTooltip.Row, {name: 'Q3', value: fmt(item.q3)}),
        m(ChartTooltip.Row, {name: 'Median', value: fmt(item.median)}),
        m(ChartTooltip.Row, {name: 'Q1', value: fmt(item.q1)}),
        m(ChartTooltip.Row, {name: 'Min', value: fmt(item.min)}),
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
    attrs: BoxplotAttrs,
    data: BoxplotData,
    width: number,
    height: number,
  ) {
    if (width === 0 || height === 0) {
      return m('svg', {width: '100%', height: '100%'});
    }

    const horizontal = (attrs.orientation ?? 'vertical') === 'horizontal';
    const fmt = attrs.formatValue ?? defaultFmt;
    const gridLines = attrs.gridLines;
    const showHGrid = gridLines === 'horizontal' || gridLines === 'both';
    const showVGrid = gridLines === 'vertical' || gridLines === 'both';

    const items = data.items;
    const n = items.length;

    // Value axis spans every item's [min..max].
    const allVals: number[] = [];
    for (const it of items) {
      allVals.push(it.min, it.max);
    }
    const vRange = niceRange(min(allVals) ?? 0, max(allVals) ?? 1);

    // For horizontal the category labels sit on the left (Y) axis, so they
    // dictate the left padding; for vertical the value tick labels do.
    const yLabels = horizontal
      ? items.map((it) => it.label)
      : vRange.ticks.map(fmt);
    const xName = horizontal ? attrs.valueLabel : attrs.categoryLabel;
    const yName = horizontal ? attrs.categoryLabel : attrs.valueLabel;
    const layout = computePlotLayout({width, height, yLabels, xName, yName});
    const {padLeft, padTop, plotW, plotH} = layout;

    // Category band geometry runs along X (vertical) or Y (horizontal).
    const catExtent = horizontal ? plotH : plotW;
    const catStart = horizontal ? padTop : padLeft;
    const bandW = n > 0 ? catExtent / n : 0;
    const bandCenter = (i: number) => catStart + (i + 0.5) * bandW;
    const boxW = bandW * BOX_BAND_FRACTION;

    // Value -> pixel. Vertical: Y grows downward so max sits at the top.
    // Horizontal: X grows rightward so min sits at the left.
    const span = vRange.max - vRange.min || 1;
    const valToPx = horizontal
      ? (v: number) => padLeft + ((v - vRange.min) / span) * plotW
      : (v: number) => padTop + plotH - ((v - vRange.min) / span) * plotH;

    // Category tick labels are thinned to avoid overlap: budget the widest
    // label against the available band size (~6px/char, ~14px/line).
    const labelStep = (() => {
      if (n === 0) return 1;
      const need = horizontal
        ? 14
        : Math.max(...items.map((it) => it.label.length)) * 6 + 6;
      return Math.max(1, Math.ceil(need / Math.max(1, bandW)));
    })();

    // Category left-axis ticks (horizontal orientation) are handed to the
    // shared frame; vertical value ticks otherwise.
    const yTicks = horizontal
      ? items
          .map((it, i) => ({label: it.label, y: bandCenter(i)}))
          .filter((_, i) => i % labelStep === 0)
      : vRange.ticks.map((t) => ({label: fmt(t), y: valToPx(t)}));

    const hitTest = (clientX: number, clientY: number, rect: DOMRect) => {
      const pos = horizontal
        ? clientY - rect.top - padTop
        : clientX - rect.left - padLeft;
      if (pos < 0 || pos > catExtent) return -1;
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
          const i = hitTest(e.clientX, e.clientY, rect);
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
      renderPlotFrame({layout, height, xName, yName, yTicks}),
      // Gridlines (drawn before boxes so they sit underneath). Horizontal
      // lines run parallel to the X axis, vertical lines to the Y axis.
      showHGrid &&
        (horizontal
          ? items.map((_, i) =>
              gridLine(padLeft, bandCenter(i), padLeft + plotW, bandCenter(i)),
            )
          : vRange.ticks.map((t) =>
              gridLine(padLeft, valToPx(t), padLeft + plotW, valToPx(t)),
            )),
      showVGrid &&
        (horizontal
          ? vRange.ticks.map((t) =>
              gridLine(valToPx(t), padTop, valToPx(t), padTop + plotH),
            )
          : items.map((_, i) =>
              gridLine(bandCenter(i), padTop, bandCenter(i), padTop + plotH),
            )),
      // Boxes + whiskers, clipped to the plot area.
      m(
        'g',
        {'clip-path': `url(#${this.clipId})`, 'shape-rendering': 'crispEdges'},
        items.map((it, i) =>
          this.renderBox(it, i, bandCenter(i), boxW, valToPx, horizontal),
        ),
      ),
      // Category ticks + labels along the category axis. For horizontal the
      // category labels live on the left axis (rendered by renderPlotFrame),
      // so only the vertical orientation draws bottom ticks here.
      !horizontal &&
        items.map((it, i) => {
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
                'text-anchor': 'middle',
                'dominant-baseline': 'hanging',
              },
              it.label,
            ),
          ]);
        }),
      // Value ticks along the bottom for horizontal orientation.
      horizontal &&
        vRange.ticks.map((t) => {
          const x = valToPx(t);
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
                'text-anchor': 'middle',
                'dominant-baseline': 'hanging',
              },
              fmt(t),
            ),
          ]);
        }),
    );
  }

  // Draw one box-and-whisker. `center` is the band-centre coordinate on the
  // category axis; the value axis geometry is mirrored between orientations.
  private renderBox(
    item: BoxplotItem,
    index: number,
    center: number,
    boxW: number,
    valToPx: (v: number) => number,
    horizontal: boolean,
  ): m.Children {
    const color = chartColorVar(index);
    const hovered = this.hover?.index === index;
    const boxHalf = boxW / 2;
    const capHalf = (boxW * CAP_BOX_FRACTION) / 2;
    const strokeWidth = hovered ? 2 : 1;

    const pMin = valToPx(item.min);
    const pQ1 = valToPx(item.q1);
    const pMed = valToPx(item.median);
    const pQ3 = valToPx(item.q3);
    const pMax = valToPx(item.max);

    // A line drawn in (value, category) space, mirrored per orientation.
    const vLine = (
      v1: number,
      v2: number,
      c1: number,
      c2: number,
      w: number,
    ) =>
      horizontal
        ? m('line', {
            'x1': v1,
            'y1': c1,
            'x2': v2,
            'y2': c2,
            'stroke': color,
            'stroke-width': w,
          })
        : m('line', {
            'x1': c1,
            'y1': v1,
            'x2': c2,
            'y2': v2,
            'stroke': color,
            'stroke-width': w,
          });

    // IQR box spanning q1..q3 along the value axis, boxW along the category
    // axis and centred on the band.
    const boxLo = Math.min(pQ1, pQ3);
    const boxLen = Math.abs(pQ3 - pQ1);
    const box = horizontal
      ? m('rect', {
          'x': boxLo,
          'y': center - boxHalf,
          'width': boxLen,
          'height': boxW,
          'fill': color,
          'fill-opacity': hovered ? BOX_FILL_OPACITY_HOVERED : BOX_FILL_OPACITY,
          'stroke': color,
          'stroke-width': strokeWidth,
        })
      : m('rect', {
          'x': center - boxHalf,
          'y': boxLo,
          'width': boxW,
          'height': boxLen,
          'fill': color,
          'fill-opacity': hovered ? BOX_FILL_OPACITY_HOVERED : BOX_FILL_OPACITY,
          'stroke': color,
          'stroke-width': strokeWidth,
        });

    return m('g', {'pointer-events': 'none'}, [
      // Whisker lines: min..q1 and q3..max, drawn down the band centre.
      vLine(pMin, pQ1, center, center, strokeWidth),
      vLine(pQ3, pMax, center, center, strokeWidth),
      // Whisker caps at the extremes.
      vLine(pMin, pMin, center - capHalf, center + capHalf, strokeWidth),
      vLine(pMax, pMax, center - capHalf, center + capHalf, strokeWidth),
      box,
      // Median: a thicker line across the box.
      vLine(pMed, pMed, center - boxHalf, center + boxHalf, hovered ? 3 : 2),
    ]);
  }
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
