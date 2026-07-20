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
import {BoxplotSvg} from '../charts_svg/boxplot_svg';

/**
 * A single box in a boxplot chart.
 */
export interface BoxplotItem {
  /** Label for this box (category name) */
  readonly label: string;
  /** Minimum value (lower whisker) */
  readonly min: number;
  /** First quartile (Q1 / 25th percentile) */
  readonly q1: number;
  /** Median (Q2 / 50th percentile) */
  readonly median: number;
  /** Third quartile (Q3 / 75th percentile) */
  readonly q3: number;
  /** Maximum value (upper whisker) */
  readonly max: number;
}

/**
 * Data provided to a BoxplotChart.
 */
export interface BoxplotData {
  readonly items: readonly BoxplotItem[];
}

export interface BoxplotAttrs {
  /**
   * Boxplot data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: BoxplotData | undefined;

  /**
   * Height of the chart in pixels. Defaults to 200.
   */
  readonly height?: number;

  /**
   * Label for the category axis.
   */
  readonly categoryLabel?: string;

  /**
   * Label for the value axis.
   */
  readonly valueLabel?: string;

  /**
   * Orientation: 'vertical' (categories on X) or 'horizontal' (categories on Y).
   * Defaults to 'vertical'.
   */
  readonly orientation?: 'vertical' | 'horizontal';

  /**
   * Fill parent container. Defaults to false.
   */
  readonly fillParent?: boolean;

  /**
   * Custom class name for the container.
   */
  readonly className?: string;

  /**
   * Format function for value axis tick values.
   */
  readonly formatValue?: (value: number) => string;

  /**
   * Show grid lines. 'horizontal' draws lines parallel to the X axis,
   * 'vertical' draws lines parallel to the Y axis, 'both' shows both.
   * Defaults to no grid lines.
   */
  readonly gridLines?: 'horizontal' | 'vertical' | 'both';
}

export class BoxplotChart implements m.ClassComponent<BoxplotAttrs> {
  view({attrs}: m.Vnode<BoxplotAttrs>) {
    return m(BoxplotSvg, attrs);
  }
}
