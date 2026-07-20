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
import {TreemapSvg} from '../charts_svg/treemap_svg';

/**
 * A node in the treemap hierarchy.
 */
export interface TreemapNode {
  /** Display name for this node */
  readonly name: string;
  /** Size value (determines rectangle area) */
  readonly value: number;
  /** Optional children for hierarchical treemaps */
  readonly children?: readonly TreemapNode[];
}

/**
 * Data provided to a TreemapChart.
 */
export interface TreemapData {
  /** Top-level nodes (can have nested children) */
  readonly nodes: readonly TreemapNode[];
}

export interface TreemapChartAttrs {
  /**
   * Treemap data to display, or undefined if loading.
   * When undefined, a loading spinner is shown.
   */
  readonly data: TreemapData | undefined;

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
   * Callback when a node is clicked.
   */
  readonly onNodeClick?: (node: TreemapNode) => void;

  /**
   * Minimum visible rectangle size. Nodes smaller than this are hidden.
   * Defaults to 10.
   */
  readonly visibleMin?: number;

  /**
   * Show labels on rectangles. Defaults to true.
   */
  readonly showLabels?: boolean;

  /**
   * Enable drill-down on click. Defaults to false.
   * When true, clicking a parent node zooms into it.
   */
  readonly enableDrillDown?: boolean;
}

export class Treemap implements m.ClassComponent<TreemapChartAttrs> {
  view({attrs}: m.Vnode<TreemapChartAttrs>) {
    return m(TreemapSvg, attrs);
  }
}
