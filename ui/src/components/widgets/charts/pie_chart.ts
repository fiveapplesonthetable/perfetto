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
import {PieChartSvg} from '../charts_svg/pie_chart_svg';

import type {LegendPosition} from './common';

/**
 * A single slice in the pie chart.
 */
export interface PieChartSlice {
  /** Label for this slice */
  readonly label: string;
  /** Numeric value for this slice */
  readonly value: number;
  /** Optional custom color for this slice */
  readonly color?: string;
}

/**
 * Data provided to a PieChart.
 */
export interface PieChartData {
  /** The slices to display */
  readonly slices: readonly PieChartSlice[];
}

export interface PieChartAttrs {
  /**
   * Pie chart data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: PieChartData | undefined;

  /**
   * Height of the chart in pixels. Defaults to 200.
   */
  readonly height?: number;

  /**
   * Fill parent container. Defaults to false.
   */
  readonly fillParent?: boolean;

  /**
   * Custom class name for the container.
   */
  readonly className?: string;

  /**
   * Format function for values in tooltips.
   */
  readonly formatValue?: (value: number) => string;

  /**
   * Show legend. Defaults to true.
   */
  readonly showLegend?: boolean;

  /**
   * Where the legend sits relative to the chart. Defaults to 'right'.
   */
  readonly legendPosition?: LegendPosition;

  /**
   * Show percentage labels on slices. Defaults to false.
   */
  readonly showLabels?: boolean;

  /**
   * Inner radius ratio for donut chart (0-1). 0 = pie, >0 = donut.
   * Defaults to 0 (pie chart).
   */
  readonly innerRadiusRatio?: number;

  /**
   * Callback when a slice is clicked.
   */
  readonly onSliceClick?: (slice: PieChartSlice) => void;
}

export class PieChart implements m.ClassComponent<PieChartAttrs> {
  view({attrs}: m.Vnode<PieChartAttrs>) {
    return m(PieChartSvg, attrs);
  }
}
