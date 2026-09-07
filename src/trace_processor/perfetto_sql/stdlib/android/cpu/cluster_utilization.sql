--
-- Copyright 2026 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--

INCLUDE PERFETTO MODULE android.cpu.cluster_type;

INCLUDE PERFETTO MODULE intervals.intersect;

-- Computes CPU utilization broken down by cluster over a given interval,
-- excluding device suspend time. Returns one row per cluster, including
-- clusters that were fully idle.
--
-- Mirrors `cpu_process_utilization_in_interval`: utilization is runtime over
-- the awake duration of the interval, aggregated (here by cluster).
--
-- This function is only designed to run over a small number of intervals
-- (10-100 at most). It will be *very slow* for large sets of intervals.
CREATE PERFETTO FUNCTION android_cpu_cluster_utilization_in_interval(
  -- Start of the interval.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur LONG
)
RETURNS TABLE(
  -- Cluster name ('little', 'medium', 'big' or 'unknown').
  cluster_type STRING,
  -- Number of cores in the cluster.
  core_count LONG,
  -- Active core-time in the interval, in milliseconds.
  active_dur_ms DOUBLE,
  -- Duty cycle in [0.0, 1.0]: active_dur / (awake_dur * core_count).
  utilization DOUBLE
)
AS
WITH
  cluster_cores AS (
    SELECT
      COALESCE(c.cluster_type, 'unknown') AS cluster_type,
      COUNT(DISTINCT cpu.ucpu) AS core_count
    FROM cpu
    LEFT JOIN android_cpu_cluster_mapping c
      USING (ucpu)
    GROUP BY 1
  ),
  active_sched AS (
    SELECT id, ts, dur, ucpu
    FROM sched
    WHERE
      NOT (utid IN (SELECT utid FROM thread WHERE is_idle))
      AND dur > 0
  ),
  cluster_active AS (
    SELECT
      COALESCE(c.cluster_type, 'unknown') AS cluster_type,
      SUM(to_monotonic(ii.ts + ii.dur) - to_monotonic(ii.ts)) AS active_dur_ns
    FROM _interval_intersect_single!($ts, $dur, active_sched) AS ii
    JOIN active_sched s
      ON s.id = ii.id
    LEFT JOIN android_cpu_cluster_mapping c
      USING (ucpu)
    GROUP BY 1
  )
SELECT
  cc.cluster_type,
  cc.core_count,
  COALESCE(ca.active_dur_ns, 0) / 1e6 AS active_dur_ms,
  iif(
    (to_monotonic($ts + $dur) - to_monotonic($ts)) > 0 AND cc.core_count > 0,
    (COALESCE(ca.active_dur_ns, 0) * 1.0)
      / ((to_monotonic($ts + $dur) - to_monotonic($ts)) * cc.core_count),
    0.0
  ) AS utilization
FROM cluster_cores cc
LEFT JOIN cluster_active ca
  USING (cluster_type);
