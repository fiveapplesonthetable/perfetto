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
import {ScatterSvg} from '../charts_svg/scatter_svg';

import type {LegendPosition} from './common';

/**
 * A single data point in a scatter chart.
 */
export interface ScatterChartPoint {
  /** X-axis value */
  readonly x: number;
  /** Y-axis value */
  readonly y: number;
  /** Optional bubble size (for bubble charts) */
  readonly size?: number;
  /** Optional per-point color */
  readonly color?: string;
  /** Optional tooltip label */
  readonly label?: string;
}

/**
 * A series (group) of points in the scatter chart.
 */
export interface ScatterChartSeries {
  /** Display name for this series (shown in legend) */
  readonly name: string;
  /** Data points for this series */
  readonly points: readonly ScatterChartPoint[];
  /** Optional custom color for this series (applies to all points without individual color) */
  readonly color?: string;
}

/**
 * Data provided to a ScatterChart.
 */
export interface ScatterChartData {
  /** The series to display */
  readonly series: readonly ScatterChartSeries[];
}

export interface ScatterChartAttrs {
  /**
   * Scatter chart data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: ScatterChartData | undefined;

  /**
   * Height of the chart in pixels. Defaults to 200.
   */
  readonly height?: number;

  /**
   * Label for the X axis.
   */
  readonly xAxisLabel?: string;

  /**
   * Label for the Y axis.
   */
  readonly yAxisLabel?: string;

  /**
   * Callback when brush selection completes (on mouseup).
   * Called with the selected X/Y rectangle.
   */
  readonly onBrush?: (range: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  }) => void;

  /**
   * Selection rectangle to highlight on the chart. When provided, a shaded
   * region is drawn. The consumer controls this state — typically by feeding
   * the `onBrush` output back in.
   */
  readonly selection?: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  };

  /**
   * Fill parent container. Defaults to false.
   */
  readonly fillParent?: boolean;

  /**
   * Custom class name for the container.
   */
  readonly className?: string;

  /**
   * Format function for X axis tick values.
   */
  readonly formatXValue?: (value: number) => string;

  /**
   * Format function for Y axis tick values.
   */
  readonly formatYValue?: (value: number) => string;

  /**
   * Use logarithmic scale for X axis. Defaults to false.
   */
  readonly logScaleX?: boolean;

  /**
   * Use logarithmic scale for Y axis. Defaults to false.
   */
  readonly logScaleY?: boolean;

  /**
   * Show legend. Defaults to true when multiple series.
   */
  readonly showLegend?: boolean;

  /**
   * Where the legend sits relative to the chart. Defaults to 'top'.
   */
  readonly legendPosition?: LegendPosition;

  /**
   * Default symbol size for points without explicit size.
   * Defaults to 8.
   */
  readonly symbolSize?: number;

  /**
   * Min/max symbol size for bubble charts (when points have size values).
   * Defaults to [5, 30].
   */
  readonly symbolSizeRange?: [number, number];

  /**
   * When true, axis ranges are computed from data min/max instead of
   * always including zero. Defaults to false.
   */
  readonly scaleAxes?: boolean;

  /**
   * Show grid lines. 'horizontal' draws lines parallel to the X axis,
   * 'vertical' draws lines parallel to the Y axis, 'both' shows both.
   * Defaults to no grid lines.
   */
  readonly gridLines?: 'horizontal' | 'vertical' | 'both';

  /**
   * Optional vertical highlight bands as [start, end] ranges on the X axis
   * (data coordinates), drawn behind the points to shade regions of interest
   * (e.g. jank intervals). Omitted/empty by default, so this is a no-op for
   * callers that don't set it.
   */
  readonly highlightBands?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly color?: string;
  }>;
}

export class Scatterplot implements m.ClassComponent<ScatterChartAttrs> {
  view({attrs}: m.Vnode<ScatterChartAttrs>) {
    return m(ScatterSvg, attrs);
  }
}
