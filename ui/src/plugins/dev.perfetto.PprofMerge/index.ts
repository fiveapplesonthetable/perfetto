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

import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import type {Store} from '../../base/store';
import {ensureExists} from '../../base/assert';
import {NUM, STR} from '../../trace_processor/query_result';
import {PprofMergePage} from './page';
import {
  PPROF_MERGE_STATE_SCHEMA,
  type MetricKind,
  type Profile,
  type ProfileMetric,
  type PprofMergeState,
} from './types';

// Multiple pprof profiles are loaded into one trace via an archive; the pprof
// importer scopes each profile by its source file (see
// pprof_trace_reader.cc). This plugin derives a simple metric per profile — the
// total of each sample-type — and lets you filter thousands of profiles by
// those metrics and merge any selection into one flamegraph, live.
export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.PprofMerge';
  static readonly description =
    'Filter and merge many pprof profiles into one flamegraph, by metric.';
  private store?: Store<PprofMergeState>;

  async onTraceLoad(trace: Trace): Promise<void> {
    const {profiles, metricKinds} = await loadProfiles(trace);
    if (profiles.length === 0) {
      return; // Not a pprof trace — stay out of the way.
    }
    this.store = trace.mountStore('dev.perfetto.PprofMerge', (init) => {
      const parsed = PPROF_MERGE_STATE_SCHEMA.safeParse(init);
      return parsed.success ? parsed.data : PPROF_MERGE_STATE_SCHEMA.parse({});
    });
    const store = ensureExists(this.store);

    trace.pages.registerPage({
      route: '/pprofmerge',
      render: () =>
        m(PprofMergePage, {
          trace,
          profiles,
          metricKinds,
          state: store.state,
          onStateChange: (s: PprofMergeState) => {
            store.edit((draft) => {
              draft.flamegraphState = s.flamegraphState;
              draft.metricKey = s.metricKey;
              draft.merge = s.merge;
              draft.range = s.range;
            });
          },
        }),
    });
    trace.sidebar.addMenuItem({
      section: 'current_trace',
      sortOrder: 11,
      text: 'Merge pprofs',
      href: '#!/pprofmerge',
      icon: 'merge',
    });
  }
}

// Loads every profile and its per-sample-type totals in a single query. The
// aggregate tables hold one row per (profile, sample-type), so this scales to
// thousands of profiles: it's one grouped scan, and the heavy callstack tables
// are only touched later, for the handful of profiles actually merged.
async function loadProfiles(
  trace: Trace,
): Promise<{profiles: Profile[]; metricKinds: MetricKind[]}> {
  const res = await trace.engine.query(`
    SELECT
      ap.scope AS scope,
      ap.id AS agg_id,
      ap.sample_type_type AS type,
      ap.sample_type_unit AS unit,
      coalesce(sum(s.value), 0) AS total,
      count(s.id) AS n
    FROM __intrinsic_aggregate_profile ap
    LEFT JOIN __intrinsic_aggregate_sample s
      ON s.aggregate_profile_id = ap.id
    GROUP BY ap.id
    ORDER BY ap.scope
  `);

  const byScope = new Map<string, Map<string, ProfileMetric>>();
  const kinds = new Map<string, MetricKind>();
  for (
    const it = res.iter({
      scope: STR,
      agg_id: NUM,
      type: STR,
      unit: STR,
      total: NUM,
      n: NUM,
    });
    it.valid();
    it.next()
  ) {
    const key = `${it.type} (${it.unit})`;
    kinds.set(key, {key, type: it.type, unit: it.unit});
    let metrics = byScope.get(it.scope);
    if (metrics === undefined) {
      metrics = new Map<string, ProfileMetric>();
      byScope.set(it.scope, metrics);
    }
    metrics.set(key, {aggId: it.agg_id, total: it.total, count: it.n});
  }

  const profiles: Profile[] = Array.from(byScope.entries()).map(
    ([scope, metrics]) => ({scope, metrics}),
  );
  return {profiles, metricKinds: Array.from(kinds.values())};
}
