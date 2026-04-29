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
import type {Trace} from '../../../public/trace';
import {time} from '../../../base/time';
import {QueryFlamegraphMetric} from '../../../components/query_flamegraph';
import {FlamegraphPanel} from '../../../components/flamegraph_panel';
import {
  Flamegraph,
  FlamegraphState,
  FlamegraphOptionalAction,
} from '../../../widgets/flamegraph';
import type {NavFn} from '../components';

export interface FlamegraphViewAttrs {
  trace: Trace;
  upid: number;
  ts: time;
  state: FlamegraphState | undefined;
  onStateChange: (state: FlamegraphState) => void;
  navigate: NavFn;
}

function buildHeapGraphMetrics(
  upid: number,
  ts: time,
  navigate: NavFn,
): ReadonlyArray<QueryFlamegraphMetric> {
  const objectsAction: FlamegraphOptionalAction = {
    name: 'Show objects of this class',
    execute: async (kv: ReadonlyMap<string, string>) => {
      const cls = kv.get('name');
      if (cls && cls !== '[Unknown]') {
        navigate('objects', {cls});
      }
    },
  };
  const nodeActions: ReadonlyArray<FlamegraphOptionalAction> = [objectsAction];

  const baseAggregatable = [
    {
      name: 'path_hash_stable',
      displayName: 'Path Hash',
      mergeAggregation: 'CONCAT_WITH_COMMA' as const,
      isVisible: (_: unknown) => false,
    },
  ];

  return [
    {
      name: 'Object Size',
      unit: 'B',
      dependencySql:
        'include perfetto module android.memory.heap_graph.class_tree;',
      statement: `
        select
          id,
          parent_id as parentId,
          ifnull(name, '[Unknown]') as name,
          root_type,
          heap_type,
          self_size as value,
          self_count,
          path_hash_stable
        from _heap_graph_class_tree
        where graph_sample_ts = ${ts} and upid = ${upid}
      `,
      unaggregatableProperties: [
        {name: 'root_type', displayName: 'Root Type'},
        {name: 'heap_type', displayName: 'Heap Type'},
      ],
      aggregatableProperties: [
        {
          name: 'self_count',
          displayName: 'Self Count',
          mergeAggregation: 'SUM',
        },
        ...baseAggregatable,
      ],
      optionalNodeActions: nodeActions,
    },
    {
      name: 'Object Count',
      unit: '',
      dependencySql:
        'include perfetto module android.memory.heap_graph.class_tree;',
      statement: `
        select
          id,
          parent_id as parentId,
          ifnull(name, '[Unknown]') as name,
          root_type,
          heap_type,
          self_size,
          self_count as value,
          path_hash_stable
        from _heap_graph_class_tree
        where graph_sample_ts = ${ts} and upid = ${upid}
      `,
      unaggregatableProperties: [
        {name: 'root_type', displayName: 'Root Type'},
        {name: 'heap_type', displayName: 'Heap Type'},
      ],
      aggregatableProperties: baseAggregatable,
      optionalNodeActions: nodeActions,
    },
    {
      name: 'Dominated Object Size',
      unit: 'B',
      dependencySql:
        'include perfetto module android.memory.heap_graph.dominator_class_tree;',
      statement: `
        select
          id,
          parent_id as parentId,
          ifnull(name, '[Unknown]') as name,
          root_type,
          heap_type,
          self_size as value,
          self_count,
          path_hash_stable
        from _heap_graph_dominator_class_tree
        where graph_sample_ts = ${ts} and upid = ${upid}
      `,
      unaggregatableProperties: [
        {name: 'root_type', displayName: 'Root Type'},
        {name: 'heap_type', displayName: 'Heap Type'},
      ],
      aggregatableProperties: [
        {
          name: 'self_count',
          displayName: 'Self Count',
          mergeAggregation: 'SUM',
        },
        ...baseAggregatable,
      ],
      optionalNodeActions: nodeActions,
    },
    {
      name: 'Dominated Object Count',
      unit: '',
      dependencySql:
        'include perfetto module android.memory.heap_graph.dominator_class_tree;',
      statement: `
        select
          id,
          parent_id as parentId,
          ifnull(name, '[Unknown]') as name,
          root_type,
          heap_type,
          self_size,
          self_count as value,
          path_hash_stable
        from _heap_graph_dominator_class_tree
        where graph_sample_ts = ${ts} and upid = ${upid}
      `,
      unaggregatableProperties: [
        {name: 'root_type', displayName: 'Root Type'},
        {name: 'heap_type', displayName: 'Heap Type'},
      ],
      aggregatableProperties: baseAggregatable,
      optionalNodeActions: nodeActions,
    },
  ];
}

const FlamegraphView: m.ClosureComponent<FlamegraphViewAttrs> = () => {
  let cachedMetrics: ReadonlyArray<QueryFlamegraphMetric> | undefined;
  let cachedKey = '';

  return {
    view({attrs}) {
      const key = `${attrs.upid}:${attrs.ts}`;
      if (key !== cachedKey) {
        cachedMetrics = buildHeapGraphMetrics(
          attrs.upid,
          attrs.ts,
          attrs.navigate,
        );
        cachedKey = key;
      }
      const metrics = cachedMetrics!;

      // Initialize state on first render or rebase to new metrics if dump
      // changed without the parent reseting state.
      if (
        attrs.state === undefined ||
        !metrics.some((mt) => mt.name === attrs.state!.selectedMetricName)
      ) {
        attrs.onStateChange(
          attrs.state === undefined
            ? Flamegraph.createDefaultState(metrics)
            : Flamegraph.updateState(attrs.state, metrics),
        );
      }

      return m(
        'div',
        {class: 'ah-view-content ah-flamegraph-view'},
        m(FlamegraphPanel, {
          trace: attrs.trace,
          metrics,
          state: attrs.state,
          onStateChange: attrs.onStateChange,
        }),
      );
    },
  };
};

export default FlamegraphView;
