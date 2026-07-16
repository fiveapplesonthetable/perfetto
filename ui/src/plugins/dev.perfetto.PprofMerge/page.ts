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

import './styles.scss';
import m from 'mithril';

import type {Trace} from '../../public/trace';
import type {QueryFlamegraphMetric} from '../../components/query_flamegraph';
import {FlamegraphPanel} from '../../components/flamegraph_panel';
import {Flamegraph} from '../../widgets/flamegraph';
import type {FlamegraphState} from '../../widgets/flamegraph';
import {Select} from '../../widgets/select';
import {Switch} from '../../widgets/switch';
import {Button} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import {Stack, StackAuto, StackFixed} from '../../widgets/stack';
import {HistogramSvg} from '../../components/widgets/charts_svg/histogram_svg';
import {computeHistogram} from '../../components/widgets/charts/histogram_loader';
import type {MetricKind, Profile, PprofMergeState} from './types';

// Cap on rendered list rows. The brush narrows the set; this just keeps the DOM
// cheap when a wide brush covers thousands. The header shows the true count.
const MAX_ROWS = 500;

export interface PprofMergePageAttrs {
  readonly trace: Trace;
  readonly profiles: ReadonlyArray<Profile>;
  readonly metricKinds: ReadonlyArray<MetricKind>;
  readonly state: PprofMergeState;
  readonly onStateChange: (state: PprofMergeState) => void;
}

// The whole page is driven by the metric histogram: pick a sample-type, brush a
// value-range on its distribution, and the profiles in that range become the
// working set that is merged (or shown individually). Everything reuses
// Perfetto's own widgets — HistogramSvg, FlamegraphPanel, Select, Switch.
export class PprofMergePage implements m.ClassComponent<PprofMergePageAttrs> {
  private flamegraphMetrics?: ReadonlyArray<QueryFlamegraphMetric>;
  // Kept in lockstep with flamegraphMetrics so the two are never mismatched
  // within a render (the persisted copy in the store can lag a frame).
  private flamegraphState?: FlamegraphState;
  private lastRebuildKey = '';

  view({attrs}: m.CVnode<PprofMergePageAttrs>): m.Children {
    const metricKey = this.metricKey(attrs);
    const r = attrs.state.range;

    // Rebuild the flamegraph metric(s) when the brush, sample-type, or merge
    // mode changes. The flamegraph widget re-queries and redraws reactively.
    const rebuildKey = `${r ? `${r.start}:${r.end}` : '-'}|${metricKey}|${attrs.state.merge}`;
    if (rebuildKey !== this.lastRebuildKey) {
      this.lastRebuildKey = rebuildKey;
      this.rebuildFlamegraph(attrs, metricKey);
    }

    return m(
      Stack,
      {orientation: 'vertical', spacing: 'none', className: 'pf-pprof-merge'},
      m(StackFixed, this.renderControls(attrs, metricKey)),
      m(
        StackAuto,
        m(
          Stack,
          {orientation: 'horizontal', spacing: 'none', fillHeight: true},
          m(
            StackFixed,
            m(
              Stack,
              {
                orientation: 'vertical',
                spacing: 'none',
                fillHeight: true,
                className: 'pf-pprof-merge__left',
              },
              m(StackFixed, this.renderHistogram(attrs, metricKey)),
              m(StackAuto, this.renderList(attrs, metricKey)),
            ),
          ),
          m(StackAuto, this.renderFlamegraph(attrs, metricKey)),
        ),
      ),
    );
  }

  // ---- top bar: sample-type selector, merge toggle, summary ----
  private renderControls(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): m.Children {
    const unit = this.unitOf(attrs, metricKey);
    const set = this.workingSet(attrs, metricKey);
    const totals = set.reduce(
      (acc, p) => {
        const met = p.metrics.get(metricKey);
        if (met) {
          acc.total += met.total;
          acc.count += met.count;
        }
        return acc;
      },
      {total: 0, count: 0},
    );
    return m(
      '.pf-pprof-merge__controls',
      m(
        'label.pf-pprof-merge__ctl',
        'Metric ',
        m(
          Select,
          {
            onchange: (e: Event) =>
              attrs.onStateChange({
                ...attrs.state,
                metricKey: (e.target as HTMLSelectElement).value,
                range: undefined, // ranges are per-metric; reset on switch
              }),
          },
          attrs.metricKinds.map((k) =>
            m('option', {value: k.key, selected: k.key === metricKey}, k.key),
          ),
        ),
      ),
      m(Switch, {
        label: 'Merge',
        checked: attrs.state.merge,
        onchange: () =>
          attrs.onStateChange({...attrs.state, merge: !attrs.state.merge}),
      }),
      m(
        '.pf-pprof-merge__summary',
        attrs.state.range === undefined
          ? `${attrs.profiles.length} profiles — brush the histogram to pick some`
          : `${attrs.state.merge ? 'Merging' : 'Showing'} ${set.length} of ` +
              `${attrs.profiles.length} profiles · ${fmtTotal(totals.total, unit)}` +
              ` · ${totals.count.toLocaleString()} samples`,
      ),
    );
  }

  // ---- the brushable metric histogram (the selection control) ----
  private renderHistogram(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): m.Children {
    const unit = this.unitOf(attrs, metricKey);
    const values = attrs.profiles.map(
      (p) => p.metrics.get(metricKey)?.total ?? null,
    );
    const data = computeHistogram(values, {bucketCount: 24});
    return m(
      '.pf-pprof-merge__hist',
      m(
        '.pf-pprof-merge__hist-head',
        m('span', `Brush to filter & merge by ${metricKey}`),
        attrs.state.range !== undefined &&
          m(Button, {
            label: 'clear',
            icon: 'clear',
            compact: true,
            onclick: () =>
              attrs.onStateChange({...attrs.state, range: undefined}),
          }),
      ),
      m(HistogramSvg, {
        data,
        height: 150,
        yAxisLabel: 'profiles',
        formatXValue: (v: number) => fmtTotal(v, unit),
        onBrush: (rng: {start: number; end: number}) =>
          attrs.onStateChange({
            ...attrs.state,
            range: {
              start: Math.min(rng.start, rng.end),
              end: Math.max(rng.start, rng.end),
            },
          }),
        selection: attrs.state.range,
      }),
    );
  }

  // ---- read-only list of the profiles currently in the brushed range ----
  private renderList(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): m.Children {
    const unit = this.unitOf(attrs, metricKey);
    const set = this.workingSet(attrs, metricKey);
    const shown = set.slice(0, MAX_ROWS);
    return m(
      '.pf-pprof-merge__list',
      m(
        '.pf-pprof-merge__list-head',
        set.length === 0
          ? 'No profiles in range'
          : `${set.length} profiles in range` +
              (set.length > shown.length ? ` (showing ${shown.length})` : ''),
      ),
      m(
        '.pf-pprof-merge__rows',
        shown.map((p) => {
          const met = p.metrics.get(metricKey);
          return m(
            '.pf-pprof-merge__row',
            m('.pf-pprof-merge__name', {title: p.scope}, p.scope),
            m('.pf-pprof-merge__val', met ? fmtTotal(met.total, unit) : '—'),
          );
        }),
      ),
    );
  }

  private renderFlamegraph(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): m.Children {
    if (this.flamegraphMetrics === undefined) {
      return m(EmptyState, {
        icon: 'merge',
        title: 'Brush the histogram to pick profiles',
        detail:
          `Drag across the histogram above to select profiles by their ` +
          `${metricKey}. They merge into one flamegraph here — or turn off ` +
          `“Merge” to flip through them individually.`,
      });
    }
    // Use the locally-reconciled state (see rebuildFlamegraph): it always names
    // a metric that exists in this.flamegraphMetrics. The persisted state can
    // momentarily lag a frame behind after a metric/merge switch, and pairing
    // new metrics with a stale selectedMetricName makes the flamegraph throw.
    const state =
      this.flamegraphState ??
      Flamegraph.createDefaultState(this.flamegraphMetrics);
    return m(FlamegraphPanel, {
      trace: attrs.trace,
      metrics: this.flamegraphMetrics,
      state,
      onStateChange: (s) => {
        this.flamegraphState = s;
        attrs.onStateChange({...attrs.state, flamegraphState: s});
      },
    });
  }

  // ---- helpers ----
  private metricKey(attrs: PprofMergePageAttrs): string {
    const k = attrs.state.metricKey;
    if (k !== undefined && attrs.metricKinds.some((x) => x.key === k)) return k;
    return attrs.metricKinds[0]?.key ?? '';
  }

  private unitOf(attrs: PprofMergePageAttrs, metricKey: string): string {
    return attrs.metricKinds.find((k) => k.key === metricKey)?.unit ?? '';
  }

  // The profiles whose metric total falls in the brushed range, sorted by that
  // metric. This is the working set — it drives the list, the summary, and the
  // merge. No brush yet -> empty.
  private workingSet(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): ReadonlyArray<Profile> {
    const r = attrs.state.range;
    if (r === undefined) return [];
    const out = attrs.profiles.filter((p) => {
      const met = p.metrics.get(metricKey);
      return met !== undefined && met.total >= r.start && met.total <= r.end;
    });
    return out.sort(
      (a, b) =>
        (b.metrics.get(metricKey)?.total ?? 0) -
        (a.metrics.get(metricKey)?.total ?? 0),
    );
  }

  private rebuildFlamegraph(
    attrs: PprofMergePageAttrs,
    metricKey: string,
  ): void {
    const kind = attrs.metricKinds.find((k) => k.key === metricKey);
    const set = this.workingSet(attrs, metricKey);
    if (kind === undefined || set.length === 0) {
      this.flamegraphMetrics = undefined;
      this.flamegraphState = undefined;
      return;
    }
    const picks: ReadonlyArray<{scope: string; aggId: number}> = set.flatMap(
      (p) => {
        const met = p.metrics.get(metricKey);
        return met === undefined ? [] : [{scope: p.scope, aggId: met.aggId}];
      },
    );
    let metrics: QueryFlamegraphMetric[];
    if (attrs.state.merge) {
      // Merge: one flamegraph summing the whole working set.
      const label =
        picks.length === 1
          ? kind.key
          : `${kind.key} — merged (${picks.length} profiles)`;
      metrics = [
        buildMergeMetric(
          label,
          kind.unit,
          picks.map((x) => x.aggId),
        ),
      ];
    } else {
      // Don't merge: one metric per profile — the flamegraph's own dropdown
      // becomes the list of profiles to flip between.
      metrics = picks.map((x) =>
        buildMergeMetric(x.scope, kind.unit, [x.aggId]),
      );
    }
    this.flamegraphMetrics = metrics;
    // Reconcile locally FIRST so this render pairs the new metrics with a valid
    // selectedMetricName; updateState() falls back to metrics[0] when the old
    // selection (a different sample-type or profile) is gone. Persist only when
    // it actually changed, to avoid a redundant store write every rebuild.
    const reconciled = Flamegraph.updateState(
      attrs.state.flamegraphState,
      metrics,
    );
    this.flamegraphState = reconciled;
    if (reconciled !== attrs.state.flamegraphState) {
      attrs.onStateChange({...attrs.state, flamegraphState: reconciled});
    }
  }
}

// Builds a flamegraph metric that MERGES the given profiles: the only change
// from the single-profile query (see dev.perfetto.AggregateProfiles) is
// `aggregate_profile_id IN (...)`. Callsites from different profiles that share
// a frame name combine in the flamegraph's own layout, so the result is the
// true summed flamegraph across the selection.
function buildMergeMetric(
  name: string,
  unit: string,
  aggIds: ReadonlyArray<number>,
): QueryFlamegraphMetric {
  const ids = aggIds.join(',');
  return {
    name,
    unit,
    nameColumnLabel: 'Symbol',
    dependencySql: 'include perfetto module callstacks.stack_profile',
    statement: `
      WITH profile_samples AS MATERIALIZED (
        SELECT callsite_id, sum(sample.value) AS sample_value
        FROM __intrinsic_aggregate_sample sample
        WHERE sample.aggregate_profile_id IN (${ids})
        GROUP BY callsite_id
      )
      SELECT
        c.id,
        c.parent_id as parentId,
        c.name,
        c.mapping_name,
        c.source_file || ':' || c.line_number as source_location,
        cast_string!(c.inlined) AS inlined,
        CASE WHEN c.is_leaf_function_in_callsite_frame
          THEN coalesce(m.sample_value, 0)
          ELSE 0
        END AS value
      FROM _callstacks_for_stack_profile_samples!(profile_samples) AS c
      LEFT JOIN profile_samples AS m USING (callsite_id)
    `,
    unaggregatableProperties: [
      {name: 'mapping_name', displayName: 'Mapping'},
      {name: 'inlined', displayName: 'Inlined', isVisible: () => false},
    ],
    aggregatableProperties: [
      {
        name: 'source_location',
        displayName: 'Source Location',
        mergeAggregation: 'ONE_OR_SUMMARY',
      },
    ],
  };
}

// Formats a metric total using the sample-type's own unit, exactly as the pprof
// declared it (nanoseconds/bytes get human scaling; any other unit is shown
// verbatim so we never misrepresent what the profile measured).
function fmtTotal(v: number, unit: string): string {
  const u = unit.toLowerCase();
  if (u === 'nanoseconds' || u === 'ns') {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} s`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} ms`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} µs`;
    return `${Math.round(v).toLocaleString()} ns`;
  }
  if (u === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = v;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  if (u === 'count' || u === '') return Math.round(v).toLocaleString();
  return `${Math.round(v).toLocaleString()} ${unit}`;
}
