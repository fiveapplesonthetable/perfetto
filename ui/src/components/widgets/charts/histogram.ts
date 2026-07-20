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
import {HistogramSvg} from '../charts_svg/histogram_svg';
import type {HistogramBucket, HistogramData} from './histogram_loader';

export interface HistogramAttrs {
  /**
   * Histogram data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   * Use the computeHistogram() utility function to compute this from raw values.
   */
  readonly data: HistogramData | undefined;

  /**
   * Height of the histogram in pixels. Defaults to 200.
   */
  readonly height?: number;

  /**
   * Label for the X axis.
   */
  readonly xAxisLabel?: string;

  /**
   * Label for the Y axis. Defaults to 'Count'.
   */
  readonly yAxisLabel?: string;

  /**
   * Callback when brush selection completes (on mouseup).
   * Called with the selected range based on mousedown and mouseup positions.
   */
  readonly onBrush?: (range: {start: number; end: number}) => void;

  /**
   * Selection range to highlight on the chart. Buckets overlapping this
   * range are drawn with a highlight color. The consumer controls this
   * state — typically by feeding the `onBrush` output back in.
   */
  readonly selection?: {readonly start: number; readonly end: number};

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
   * Bar color. Defaults to theme primary color.
   */
  readonly barColor?: string;

  /**
   * Per-bucket color override. Called once per bucket; return an index into
   * the theme's chart color palette (`chartColors`) to colour that bar, or
   * undefined to fall back to `barColor`. The index is taken modulo the
   * palette length, so callers don't need to know how many colors exist.
   * The NULL bar (when present) is passed `bucket = undefined`. Selection
   * highlighting still takes precedence over the returned color.
   */
  readonly bucketColor?: (
    bucket: HistogramBucket | undefined,
    index: number,
  ) => number | undefined;

  /**
   * Bar hover color. Defaults to theme accent color.
   */
  readonly barHoverColor?: string;

  /**
   * Use logarithmic scale for Y axis. Useful when count values
   * span multiple orders of magnitude. Defaults to false.
   */
  readonly logScale?: boolean;

  /**
   * When true, X axis (dimension) ticks will be snapped to integer values.
   * Use when the histogram data represents integer-valued quantities.
   * The Y axis (measure) always uses integer ticks since it shows counts.
   */
  readonly integerDimension?: boolean;
}

export class Histogram implements m.ClassComponent<HistogramAttrs> {
  view({attrs}: m.Vnode<HistogramAttrs>) {
    return m(HistogramSvg, attrs);
  }
}
