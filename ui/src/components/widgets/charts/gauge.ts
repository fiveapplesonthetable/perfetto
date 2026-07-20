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
import {GaugeSvg} from '../charts_svg/gauge_svg';
import type {SingleValueData} from './single_value_loader';

export interface GaugeAttrs {
  /** The aggregated data to display, or undefined if loading. */
  readonly data: SingleValueData | undefined;
  /** Whether the data is still being fetched. */
  readonly isPending: boolean;
  /** Label to display below the value. */
  readonly label: string;
  /** Height of the chart in pixels. Defaults to 300. */
  readonly height?: number;
  /** Fill parent container. Defaults to false. */
  readonly fillParent?: boolean;
  /** Minimum value of the gauge scale. Defaults to 0. */
  readonly min?: number;
  /** Maximum value of the gauge scale. Defaults to 100. */
  readonly max?: number;
  /**
   * Gauge diameter as a CSS-style percentage string (e.g. '80%').
   * Controls the radius of the gauge arc relative to the container.
   * Defaults to '75%'.
   */
  readonly diameter?: string;
  /** Custom formatter for the displayed value. */
  readonly formatValue?: (value: number) => string;
}

/**
 * A gauge widget that displays a single aggregated value as an ECharts
 * gauge with arc, progress, and pointer.
 */

export class Gauge implements m.ClassComponent<GaugeAttrs> {
  view({attrs}: m.Vnode<GaugeAttrs>) {
    return m(GaugeSvg, attrs);
  }
}
