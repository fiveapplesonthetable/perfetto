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

// Sources the ProcessState explorer directly from an Android `dumpsys activity
// --proto` capture — no AOSP producer and no custom process_state_snapshot
// packet required.
//
// The dumpsys ActivityManagerServiceProto is delivered into the trace via
// Perfetto's ExtensionDescriptor mechanism (a TrackEvent extension), so
// trace_processor auto-decodes the whole tree into the `args` table with no
// per-field importer. This module pivots those array-indexed args
// (`am_dumpsys.processes.lru_procs.list[N]…`, `…service_records[M].connections
// [K]…`) into the `_ps_*` relations the explorer reads, so the identical graph
// / table / details UX renders on top of a plain dumpsys capture.
//
// If the trace has no dumpsys args, we fall back to aliasing the legacy
// `android_process_state_*` tables (produced by the android.process_state data
// source) so older traces keep working unchanged.

import type {Engine} from '../../trace_processor/engine';
import {NUM} from '../../trace_processor/query_result';

// Each am_dumpsys TrackEvent is one snapshot; its args share one arg_set_id.
// We map every such slice to a 0-based snapshot id (ordered by time) and key
// the whole pivot on arg_set_id, so a directory of dumps (the --in-dir series)
// becomes a scrubable timeline the explorer's snapshot nav walks. A single
// dump is just the one-snapshot case.
const PIVOT_SQL: string[] = [
  // The snapshot index: one row per am_dumpsys event, with its arg_set_id.
  `CREATE PERFETTO TABLE _ps_snap_src AS
   SELECT ROW_NUMBER() OVER (ORDER BY ts) - 1 AS id, ts, arg_set_id
   FROM slice WHERE name = 'am_dumpsys'`,

  `CREATE PERFETTO TABLE _ps_snapshot AS
   SELECT id, ts, 0 AS oom_adj_reason, 0 AS is_awake, 0 AS unlocking,
     0 AS expanded_notification_shade, 0 AS last_memory_level_normal,
     NULL AS top_process_state, NULL AS home_pid, NULL AS heavy_weight_pid,
     NULL AS previous_pid, NULL AS dozing_ui_pid, NULL AS idle_allowlist_appids
   FROM _ps_snap_src`,

  // Process nodes per snapshot: pid / name / oom-adj (numeric + tier string) /
  // persistent / the adj_source pid that keeps each one alive ("why alive").
  // Grouped by (arg_set_id, list index) so identical indices in different
  // snapshots don't collide.
  `CREATE PERFETTO TABLE _ps_process AS
   WITH base AS (
     SELECT a.arg_set_id, substr(a.key, 1, instr(a.key, ']')) AS node,
            a.key, a.int_value, a.string_value
     FROM args a JOIN _ps_snap_src s USING (arg_set_id)
     WHERE a.key LIKE 'am_dumpsys.processes.lru_procs.list[%')
   SELECT sn.id AS snapshot_id,
     MAX(CASE WHEN key LIKE '%].proc.pid' THEN int_value END) AS pid,
     MAX(CASE WHEN key LIKE '%].proc.uid' THEN int_value END) AS uid,
     MAX(CASE WHEN key LIKE '%].proc.process_name' THEN string_value END)
       AS process_name,
     MAX(CASE WHEN key LIKE '%].detail.cur_adj' THEN int_value END) AS cur_adj,
     MAX(CASE WHEN key LIKE '%].oom_adj' THEN string_value END) AS adj_type,
     MAX(CASE WHEN key LIKE '%].state' THEN int_value END) AS cur_proc_state,
     MAX(CASE WHEN key LIKE '%].persistent' THEN int_value END) AS persistent,
     MAX(CASE WHEN key LIKE '%].adj_source_proc.pid' THEN int_value END)
       AS adj_source_pid,
     MAX(CASE WHEN key LIKE '%].sched_group' THEN int_value END)
       AS cur_sched_group,
     -- Not present in the dumpsys proto; declared so the details-panel
     -- projection resolves (rendered empty).
     NULL AS cur_capability,
     NULL AS is_frozen,
     NULL AS cached_adj
   FROM base JOIN _ps_snap_src sn USING (arg_set_id)
   GROUP BY base.arg_set_id, node HAVING pid IS NOT NULL`,

  // Services with a snapshot-unique synthetic id, keyed back to their
  // (arg_set_id, source-proto path) so bindings can join within a snapshot.
  `CREATE PERFETTO TABLE _ps_service AS
   WITH k AS (
     SELECT a.arg_set_id, a.key, a.int_value, a.string_value,
            instr(a.key, ']') AS b1
     FROM args a JOIN _ps_snap_src s USING (arg_set_id)
     WHERE a.key LIKE
       'am_dumpsys.services.active_services.services_by_users[%].service_records[%]%'),
   k2 AS (SELECT *, b1 + instr(substr(key, b1 + 1), ']') AS b2 FROM k),
   g AS (
     SELECT arg_set_id, substr(key, 1, b2) AS svc,
       MAX(CASE WHEN substr(key, b2 + 1) = '.pid' THEN int_value END) AS owning_pid,
       MAX(CASE WHEN substr(key, b2 + 1) = '.short_name' THEN string_value END)
         AS short_name
     FROM k2 GROUP BY arg_set_id, svc HAVING owning_pid IS NOT NULL)
   SELECT sn.id AS snapshot_id,
     ROW_NUMBER() OVER (ORDER BY g.arg_set_id, g.svc) AS service_id,
     g.arg_set_id, g.svc, g.owning_pid, g.short_name
   FROM g JOIN _ps_snap_src sn USING (arg_set_id)`,

  // Bindings: each connection's client pid → its service (joined within the
  // same snapshot), with the FG-service flag (enum value 10) decoded.
  `CREATE PERFETTO TABLE _ps_binding AS
   WITH k AS (
     SELECT a.arg_set_id, a.key, a.int_value, instr(a.key, ']') AS b1
     FROM args a JOIN _ps_snap_src s USING (arg_set_id)
     WHERE a.key LIKE
       'am_dumpsys.services.active_services.services_by_users[%].service_records[%].connections[%]%'),
   k2 AS (SELECT *, b1 + instr(substr(key, b1 + 1), ']') AS b2 FROM k),
   conn AS (
     SELECT arg_set_id, substr(key, 1, b2) AS svc,
       substr(key, 1, b2 + instr(substr(key, b2 + 1), ']') + 12) AS cprefix,
       key, int_value FROM k2)
   SELECT sv.snapshot_id, sv.service_id,
     MAX(CASE WHEN conn.key LIKE '%].client_pid' THEN conn.int_value END)
       AS client_pid,
     MAX(CASE WHEN conn.key LIKE '%].flags[%' AND conn.int_value = 10 THEN 1
              ELSE 0 END) AS flag_foreground_service
   FROM conn JOIN _ps_service sv
     ON sv.arg_set_id = conn.arg_set_id AND sv.svc = conn.svc
   GROUP BY conn.arg_set_id, conn.cprefix, sv.service_id
   HAVING client_pid IS NOT NULL`,

  // Content providers aren't in the dumpsys `services` section; expose empty
  // relations so the provider-edge queries return nothing cleanly.
  `CREATE PERFETTO TABLE _ps_provider AS
   SELECT 0 AS snapshot_id, 0 AS provider_id, 0 AS owning_pid, '' AS authority
   WHERE 0`,
  `CREATE PERFETTO TABLE _ps_provider_binding AS
   SELECT 0 AS snapshot_id, 0 AS provider_id, 0 AS client_pid WHERE 0`,
  `CREATE PERFETTO TABLE _ps_uid AS SELECT 0 AS snapshot_id, 0 AS uid WHERE 0`,
];

// Legacy path: alias the android.process_state tables under the _ps_* names the
// explorer now uses, so traces from that data source keep working.
const ALIAS_SQL: string[] = [
  `CREATE PERFETTO VIEW _ps_snapshot AS SELECT * FROM android_process_state_snapshot`,
  `CREATE PERFETTO VIEW _ps_process AS SELECT * FROM android_process_state_process`,
  `CREATE PERFETTO VIEW _ps_service AS SELECT * FROM android_process_state_service`,
  `CREATE PERFETTO VIEW _ps_binding AS SELECT * FROM android_process_state_binding`,
  `CREATE PERFETTO VIEW _ps_provider AS SELECT * FROM android_process_state_provider`,
  `CREATE PERFETTO VIEW _ps_provider_binding AS SELECT * FROM android_process_state_provider_binding`,
  `CREATE PERFETTO VIEW _ps_uid AS SELECT * FROM android_process_state_uid`,
];

/**
 * Builds the `_ps_*` relations the explorer reads. Returns the number of
 * process rows available (0 → no process-state data in this trace, the plugin
 * should not activate).
 */
export async function buildProcessState(engine: Engine): Promise<number> {
  const hasDumpsys = await engine.query(
    `SELECT count(*) AS n FROM args WHERE key GLOB 'am_dumpsys.*'`,
  );
  const stmts = hasDumpsys.iter({n: NUM}).n > 0 ? PIVOT_SQL : ALIAS_SQL;
  try {
    for (const s of stmts) await engine.query(s);
  } catch {
    // Either the dumpsys args weren't shaped as expected or the legacy tables
    // don't exist — leave the plugin inactive.
    return 0;
  }
  const n = await engine.query(`SELECT count(*) AS n FROM _ps_process`);
  return n.iter({n: NUM}).n;
}
