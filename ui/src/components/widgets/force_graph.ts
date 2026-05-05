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

// Reusable force-directed graph widget. Backed by ECharts' built-in
// `graph` series with the `force` layout, rendered through perfetto's
// EChartView wrapper — the same charting stack as bar_chart, line_chart,
// scatterplot, sankey, etc.
//
// Used by:
//   * com.android.ProcessStateExplorer — process / binding graph
//   * (any future plugin that needs a small directed graph viz)
//
// The widget owns nothing perfetto-specific: pass in an array of nodes
// and links. Layout, colours and labels are all driven from per-node /
// per-link attributes; an optional onNodeClick callback delivers
// click-to-focus interactions to the host.

import m from 'mithril';
import * as echarts from 'echarts/core';
import {GraphChart} from 'echarts/charts';
import {EChartView} from './charts/echart_view';

// ECharts is tree-shaken: each chart series must be explicitly registered
// before it can be rendered. echarts.use() is idempotent so registering on
// module load is safe.
echarts.use([GraphChart]);

export interface ForceGraphNode {
  id: string | number;
  label?: string;
  // Node fill colour (CSS string). Default: '#bbb'.
  color?: string;
  // Node radius in px. Default: 5.
  radius?: number;
}

export interface ForceGraphLink {
  source: string | number;
  target: string | number;
  // Edge stroke colour (CSS string). Default: '#888'.
  color?: string;
  // Edge stroke width in px. Default: 0.6.
  width?: number;
}

export interface ForceGraphAttrs {
  nodes: ReadonlyArray<ForceGraphNode>;
  links: ReadonlyArray<ForceGraphLink>;
  width: number;
  height: number;
  // Optional force-simulation knobs. Sensible defaults for a small graph.
  // linkDistance: target distance between connected nodes (px).
  // repulsion: how strongly nodes push each other away. Larger = sparser.
  linkDistance?: number;
  repulsion?: number;
  // Fired when the user clicks a node. The id matches the node's input id
  // (number or string), with numeric strings re-coerced to numbers when
  // the input id was numeric.
  onNodeClick?: (id: string | number) => void;
}

interface EChartsClickPayload {
  readonly dataType?: string;
  readonly data?: {readonly id?: string};
}

/**
 * Self-contained ECharts-backed force-directed graph widget. Builds a
 * `graph`-series ECharts option from the input nodes / links and renders
 * it via EChartView.
 *
 * Example:
 *
 *   m(ForceGraph, {
 *     nodes: [{id: 1, label: 'a', color: 'red'},
 *             {id: 2, label: 'b'}],
 *     links: [{source: 1, target: 2}],
 *     width: 800,
 *     height: 400,
 *     onNodeClick: (id) => console.log('clicked', id),
 *   })
 */
export class ForceGraph implements m.ClassComponent<ForceGraphAttrs> {
  view({attrs}: m.CVnode<ForceGraphAttrs>): m.Children {
    const {nodes, links, width, height, linkDistance, repulsion, onNodeClick} =
      attrs;

    // ECharts' graph series matches link.source / link.target against the
    // string `id` field of node items, so coerce both sides to strings to
    // avoid type-mismatch lookups.
    const presentIds = new Set(nodes.map((n) => String(n.id)));
    const numericIdInputs = nodes.every((n) => typeof n.id === 'number');

    const option: echarts.EChartsCoreOption = {
      tooltip: {
        confine: true,
        formatter: (p: unknown) => {
          const params = p as {dataType?: string; name?: string};
          return params.dataType === 'node' ? params.name ?? '' : '';
        },
      },
      series: [
        {
          type: 'graph',
          layout: 'force',
          width,
          height,
          // Pan and zoom with mouse drag / wheel. Built into echarts;
          // gives the user a way to inspect dense parts of the graph
          // without us re-implementing it.
          roam: true,
          // Drag a node to pin it; the rest of the layout settles around.
          draggable: true,
          // Light scaling on hover so the user knows what's clickable.
          emphasis: {focus: 'adjacency', scale: true},
          force: {
            repulsion: repulsion ?? 80,
            edgeLength: linkDistance ?? 70,
            // Pull toward centre so the graph stays in the viewport.
            gravity: 0.05,
            // Re-run layout if the data changes (e.g. snapshot scrubbed).
            layoutAnimation: true,
          },
          label: {
            show: true,
            position: 'bottom',
            fontSize: 9,
          },
          lineStyle: {
            opacity: 0.85,
          },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 5,
          data: nodes.map((n) => ({
            id: String(n.id),
            name: n.label ?? String(n.id),
            symbolSize: (n.radius ?? 5) * 2,
            itemStyle: {color: n.color ?? '#bbb'},
          })),
          links: links
            .filter(
              (l) =>
                presentIds.has(String(l.source)) &&
                presentIds.has(String(l.target)),
            )
            .map((l) => ({
              source: String(l.source),
              target: String(l.target),
              lineStyle: {
                color: l.color ?? '#888',
                width: l.width ?? 0.6,
              },
            })),
        },
      ],
    };

    const eventHandlers =
      onNodeClick === undefined
        ? undefined
        : [
            {
              eventName: 'click',
              handler: (...args: unknown[]) => {
                const payload = args[0] as EChartsClickPayload;
                if (payload.dataType !== 'node') return;
                const idStr = payload.data?.id;
                if (idStr === undefined) return;
                onNodeClick(numericIdInputs ? Number(idStr) : idStr);
              },
            },
          ];

    return m(EChartView, {option, height, eventHandlers});
  }
}
