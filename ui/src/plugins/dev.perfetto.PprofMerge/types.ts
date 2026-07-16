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

import {FLAMEGRAPH_STATE_SCHEMA} from '../../widgets/flamegraph';
import {z} from 'zod';

// Persisted page state. `selectedScopes` is the set of profiles (by source file
// scope) currently checked for merging; `metricKey` is which sample-type is
// being viewed/merged (e.g. "cpu (nanoseconds)").
export const PPROF_MERGE_STATE_SCHEMA = z.object({
  flamegraphState: FLAMEGRAPH_STATE_SCHEMA.optional(),
  // Which sample-type is being viewed/merged (e.g. "cpu (nanoseconds)").
  metricKey: z.string().optional(),
  // Whether to sum the working set into one flamegraph (true) or keep the
  // profiles separate and flip between them (false = "don't merge").
  merge: z.boolean().default(true),
  // The brushed value-range on the metric histogram. This IS the selection:
  // the profiles whose metric total falls in [start, end] are the working set
  // that gets merged. Undefined = nothing brushed yet.
  range: z.object({start: z.number(), end: z.number()}).optional(),
});
export type PprofMergeState = z.infer<typeof PPROF_MERGE_STATE_SCHEMA>;

// The derived total for one (profile, sample-type). `aggId` is the
// __intrinsic_aggregate_profile row that carries this profile's samples for
// this sample-type; it's what the merge query filters on.
export interface ProfileMetric {
  readonly aggId: number;
  readonly total: number; // SUM(aggregate_sample.value)
  readonly count: number; // number of sample rows
}

// One source pprof, keyed by its file (scope), with its per-sample-type totals.
export interface Profile {
  readonly scope: string;
  readonly metrics: ReadonlyMap<string, ProfileMetric>; // metricKey -> metric
}

// A distinct sample-type present across the loaded profiles.
export interface MetricKind {
  readonly key: string; // "cpu (nanoseconds)"
  readonly type: string; // "cpu"
  readonly unit: string; // "nanoseconds"
}
