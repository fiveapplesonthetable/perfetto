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
import {BarChartSvg} from '../charts_svg/bar_chart_svg';
import {type ChartAggregation, percentile} from './chart_utils';
import type {LegendPosition} from './common';

/**
 * A single bar in the bar chart.
 */
export interface BarChartItem {
  /** Label for this bar (displayed on the dimension axis). */
  readonly label: string | number;
  /** Numeric value for this bar. */
  readonly value: number;
}

/**
 * A named series of bars (used for stacked/grouped bar charts).
 */
export interface BarChartSeries {
  /** Display name for this series (shown in legend). */
  readonly name: string;
  /** Bars in this series. */
  readonly items: readonly BarChartItem[];
}

/**
 * Data provided to a BarChart.
 *
 * Use `items` for a simple single-series bar chart, or `series` for
 * stacked/grouped bar charts. When `series` is provided, `items` is ignored.
 */
export interface BarChartData {
  /** The bars to display (single series). */
  readonly items: readonly BarChartItem[];
  /** Multiple named series for stacked bar charts. */
  readonly series?: readonly BarChartSeries[];
}

export interface BarChartAttrs {
  /**
   * Bar chart data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: BarChartData | undefined;

  /**
   * Height of the chart in pixels. Defaults to 200.
   */
  readonly height?: number;

  /**
   * Label for the dimension axis (the categorical/label axis).
   * Placed on the X axis in vertical mode, Y axis in horizontal mode.
   */
  readonly dimensionLabel?: string;

  /**
   * Label for the measure axis (the numeric value axis).
   * Placed on the Y axis in vertical mode, X axis in horizontal mode.
   */
  readonly measureLabel?: string;

  /**
   * Fill parent container. Defaults to false.
   */
  readonly fillParent?: boolean;

  /**
   * Custom class name for the container.
   */
  readonly className?: string;

  /**
   * Format function for dimension axis tick values (bar labels).
   * When provided, this function is used to format the label of each bar.
   */
  readonly formatDimension?: (value: string | number) => string;

  /**
   * Format function for measure axis tick values.
   */
  readonly formatMeasure?: (value: number) => string;

  /**
   * Bar color. Defaults to theme primary color.
   */
  readonly barColor?: string;

  /**
   * Bar hover color. Defaults to theme accent color.
   */
  readonly barHoverColor?: string;

  /**
   * Use logarithmic scale for the measure axis. Defaults to false.
   */
  readonly logScale?: boolean;

  /**
   * When true, measure axis ticks will be snapped to integer values.
   */
  readonly integerMeasure?: boolean;

  /**
   * Chart orientation. Defaults to 'vertical'.
   * - 'vertical': bars grow upward, dimension on X axis, measure on Y axis.
   * - 'horizontal': bars grow rightward, dimension on Y axis, measure on X.
   */
  readonly orientation?: 'vertical' | 'horizontal';

  /**
   * Show grid lines. 'horizontal' draws lines parallel to the X axis,
   * 'vertical' draws lines parallel to the Y axis, 'both' shows both.
   * Defaults to no grid lines.
   */
  readonly gridLines?: 'horizontal' | 'vertical' | 'both';

  /**
   * Callback when brush selection completes (on mouseup).
   * Called with the labels of all bars in the brushed range.
   */
  readonly onBrush?: (labels: Array<string | number>) => void;

  /**
   * Selection labels to highlight on the chart. Bars whose labels are in
   * this array are drawn with a highlight color. The consumer controls
   * this state — typically by feeding the `onBrush` output back in.
   */
  readonly selection?: ReadonlyArray<string | number>;

  /**
   * Where the legend sits relative to the chart (stacked charts only).
   * Defaults to 'top'.
   */
  readonly legendPosition?: LegendPosition;
}

export class BarChart implements m.ClassComponent<BarChartAttrs> {
  view({attrs}: m.Vnode<BarChartAttrs>) {
    return m(BarChartSvg, attrs);
  }
}

export function aggregateBarChartData<T>(
  items: readonly T[],
  dimension: (item: T) => string | number,
  measure: (item: T) => number,
  aggregation: ChartAggregation,
): BarChartData {
  const groups = new Map<string | number, number[]>();
  for (const item of items) {
    const key = dimension(item);
    let values = groups.get(key);
    if (values === undefined) {
      values = [];
      groups.set(key, values);
    }
    values.push(measure(item));
  }

  const result: BarChartItem[] = [];
  for (const [label, values] of groups) {
    result.push({label, value: aggregate(values, aggregation)});
  }

  result.sort((a, b) => b.value - a.value);
  return {items: result};
}

function aggregate(values: number[], agg: ChartAggregation): number {
  switch (agg) {
    case 'ANY':
    case 'MIN':
      return values.reduce((a, b) => Math.min(a, b), Infinity);
    case 'COUNT':
      return values.length;
    case 'SUM':
      return values.reduce((a, b) => a + b, 0);
    case 'AVG':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'MAX':
      return values.reduce((a, b) => Math.max(a, b), -Infinity);
    case 'COUNT_DISTINCT':
      return new Set(values).size;
    case 'P25':
    case 'P50':
    case 'P75':
    case 'P90':
    case 'P95':
    case 'P99':
      return percentile(values, Number(agg.slice(1)));
  }
}
