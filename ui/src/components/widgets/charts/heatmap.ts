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
import {HeatmapSvg} from '../charts_svg/heatmap_svg';

/**
 * Data provided to a HeatmapChart.
 * The grid is defined by xLabels, yLabels, and a values matrix.
 */
export interface HeatmapData {
  /** Labels for the X axis (columns). */
  readonly xLabels: readonly string[];
  /** Labels for the Y axis (rows). */
  readonly yLabels: readonly string[];
  /**
   * Values as [xIndex, yIndex, value] triples.
   * Missing entries are treated as 0.
   */
  readonly values: ReadonlyArray<readonly [number, number, number]>;
  /** Minimum value in the dataset (for color scale). */
  readonly min: number;
  /** Maximum value in the dataset (for color scale). */
  readonly max: number;
}

export interface HeatmapAttrs {
  /**
   * Heatmap data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: HeatmapData | undefined;

  /**
   * Height of the chart in pixels. Defaults to 300.
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
   * Fill parent container. Defaults to false.
   */
  readonly fillParent?: boolean;

  /**
   * Custom class name for the container.
   */
  readonly className?: string;

  /**
   * Format function for cell values.
   */
  readonly formatValue?: (value: number) => string;

  /**
   * Callback when brush selection completes (on mouseup).
   * Called with the x and y labels of all cells in the brushed rectangle.
   */
  readonly onBrush?: (selection: {
    xLabels: string[];
    yLabels: string[];
  }) => void;

  /**
   * Selection to highlight on the chart. Cells at the intersection of
   * the selected xLabels and yLabels are drawn with a highlight color.
   * The consumer controls this state — typically by feeding the
   * `onBrush` output back in.
   */
  readonly selection?: {
    readonly xLabels: ReadonlyArray<string>;
    readonly yLabels: ReadonlyArray<string>;
  };
}

export class HeatmapChart implements m.ClassComponent<HeatmapAttrs> {
  view({attrs}: m.Vnode<HeatmapAttrs>) {
    return m(HeatmapSvg, attrs);
  }
}
