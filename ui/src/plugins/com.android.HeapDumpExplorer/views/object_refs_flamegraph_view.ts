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
import type {QueryFlamegraphMetric} from '../../../components/query_flamegraph';
import {FlamegraphPanel} from '../../../components/flamegraph_panel';
import {
  Flamegraph,
  type FlamegraphState,
  type FlamegraphOptionalAction,
} from '../../../widgets/flamegraph';
import type {NavFn} from '../components';

// Whether the tree follows references out of the object ('out': what this
// object reaches) or into it ('in': what reaches this object).
export type RefDirection = 'in' | 'out';

interface ObjectRefsFlamegraphViewAttrs {
  readonly trace: Trace;
  readonly objId: number;
  readonly dir: RefDirection;
  readonly navigate: NavFn;
}

// Node action: jump to the heap object the frame represents. `object_id` is
// emitted as a hidden unaggregatable property so it survives into the
// flamegraph node's matchingColumns.
function openObjectAction(navigate: NavFn): FlamegraphOptionalAction {
  return {
    name: 'Open object',
    execute: async ({properties}) => {
      const objId = properties.get('object_id');
      if (objId === undefined) return;
      navigate('object', {id: Number(objId)});
    },
  };
}

// A single self-size metric over _heap_graph_object_reference_tree, rooted at
// `objId`. The reference column orientation selects the direction: outgoing
// follows owner_id -> owned_id, incoming follows owned_id -> owner_id.
function buildMetrics(
  objId: number,
  dir: RefDirection,
  navigate: NavFn,
): ReadonlyArray<QueryFlamegraphMetric> {
  const src = dir === 'out' ? 'owner_id' : 'owned_id';
  const dest = dir === 'out' ? 'owned_id' : 'owner_id';
  return [
    {
      name: 'Self Size',
      unit: 'B',
      dependencySql:
        'include perfetto module android.memory.heap_graph.reference_tree;',
      statement: `
        select
          id,
          parent_id as parentId,
          ifnull(name, '[Unknown]') as name,
          self_size as value,
          CAST(id AS TEXT) as object_id
        from _heap_graph_object_reference_tree!(${objId}, ${src}, ${dest})
      `,
      unaggregatableProperties: [
        {name: 'object_id', displayName: 'Object', isVisible: () => false},
      ],
      optionalNodeActions: [openObjectAction(navigate)],
    },
  ];
}

// A throwaway, self-contained flamegraph of every object reachable from a
// single object by following references in one direction. Owns its own
// FlamegraphState (the tab is keyed per (objId, dir) so each instance is
// independent); the session only tracks that the tab is open.
const ObjectRefsFlamegraphView: m.ClosureComponent<
  ObjectRefsFlamegraphViewAttrs
> = () => {
  let metrics: ReadonlyArray<QueryFlamegraphMetric> | undefined;
  let state: FlamegraphState | undefined;
  let cachedKey: string | undefined;

  return {
    view({attrs}) {
      const key = `${attrs.dir}:${attrs.objId}`;
      if (metrics === undefined || key !== cachedKey) {
        metrics = buildMetrics(attrs.objId, attrs.dir, attrs.navigate);
        cachedKey = key;
        state = undefined;
      }
      if (state === undefined) {
        state = Flamegraph.createDefaultState(metrics);
      }
      return m(
        'div',
        {class: 'pf-hde-view-content pf-hde-flamegraph-view'},
        m(FlamegraphPanel, {
          trace: attrs.trace,
          metrics,
          state,
          onStateChange: (s: FlamegraphState) => {
            state = s;
          },
        }),
      );
    },
  };
};

export default ObjectRefsFlamegraphView;
