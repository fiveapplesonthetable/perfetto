--
-- Copyright 2024 The Android Open Source Project
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

INCLUDE PERFETTO MODULE slices.flat_slices;

INCLUDE PERFETTO MODULE sched.thread_executing_span;

-- The previous implementation eagerly materialised four whole-trace
-- tables at module load: the per-root critical-path walk, a thread_state
-- × flat-slice SPAN_LEFT_JOIN, the (CP × thread_state-slice) interval
-- intersect, and the joined cross product. On a 17 MB Android trace
-- this was ~95 s of `INCLUDE PERFETTO MODULE` cost for queries that
-- scoped down to a single `(root_utid, ts, dur)` window. Every consumer
-- of the module — `_thread_executing_span_critical_path_stack`,
-- `_critical_path_stack`, `_thread_executing_span_critical_path_graph`,
-- and the matching UI commands — already passes such a window, so the
-- pre-aggregation is wasted work.
--
-- The function bodies below now build the same intermediates lazily,
-- restricted to the rows that overlap the requested window: the walk
-- runs over only the wakeup nodes for `root_utid` that intersect
-- `[ts, ts + dur]`, the SPAN_LEFT_JOIN virtual tables are queried with
-- `WHERE utid = …` push-down, and the SPAN_JOIN of self and CP is
-- replaced by `_interval_intersect!` over the local CTEs (the
-- LEFT-join semantics survive on the SPAN_LEFT_JOIN side, which is
-- the part that needs to keep thread_state rows with no overlapping
-- slice; the self vs CP join is inner in both designs).

-- thread_state and flat-slice projections used by the
-- SPAN_LEFT_JOIN virtual tables below. Cheap: no rows are produced
-- until the function body queries them with a `utid` filter.
CREATE PERFETTO VIEW _span_thread_state_view AS
SELECT
  id AS thread_state_id,
  ts,
  dur,
  utid,
  state,
  blocked_function AS function,
  io_wait,
  cpu
FROM thread_state;

CREATE PERFETTO VIEW _span_slice_view AS
SELECT
  slice_id,
  depth AS slice_depth,
  cast_int!(ts) AS ts,
  cast_int!(dur) AS dur,
  utid
FROM _slice_flattened;

-- Lazy SPAN_LEFT_JOIN of thread_state × flat-slice. Used by
-- `_critical_path_stack` for the *blocker* side, filtered to the small
-- set of utids the per-window CP touches.
CREATE VIRTUAL TABLE _span_thread_state_slice_sp USING SPAN_LEFT_JOIN (
    _span_thread_state_view PARTITIONED utid,
    _span_slice_view PARTITIONED utid);

-- Lazy SPAN_LEFT_JOIN of thread_state × flat-slice for the *self*
-- side. Filtered to `utid = $root_utid` inside the function body.
CREATE VIRTUAL TABLE _self_sp USING SPAN_LEFT_JOIN (thread_state PARTITIONED utid, _slice_flattened PARTITIONED utid);

CREATE PERFETTO VIEW _self_view AS
SELECT
  id AS self_thread_state_id,
  slice_id AS self_slice_id,
  ts,
  dur,
  utid AS root_utid,
  state AS self_state,
  blocked_function AS self_function,
  cpu AS self_cpu,
  io_wait AS self_io_wait,
  depth AS self_slice_depth
FROM _self_sp;

-- Equivalent of `_self_and_critical_path_sp WHERE root_utid = $root_utid
-- AND dur > 0`, scoped to a query window. Extracted into its own
-- function so the downstream `_critical_path_stack` body — which
-- references `relevant_spans` ten times across self/critical/cpu UNION
-- ALLs — pays the upstream cost only once. The walk runs only over
-- wakeup nodes for `$root_utid` that overlap `[ts, ts + dur]`; the
-- SPAN_LEFT_JOIN virtual tables are queried with `WHERE utid = …` /
-- `WHERE utid IN (…)` so partition push-down keeps them cheap.
CREATE PERFETTO FUNCTION _critical_path_relevant_spans(
    root_utid JOINID(thread.id),
    ts TIMESTAMP,
    dur DURATION
)
RETURNS TABLE (
  self_thread_state_id LONG,
  self_state STRING,
  self_slice_id LONG,
  self_slice_depth LONG,
  self_function STRING,
  self_io_wait LONG,
  thread_state_id LONG,
  state STRING,
  function STRING,
  io_wait LONG,
  slice_id LONG,
  slice_depth LONG,
  cpu LONG,
  utid JOINID(thread.id),
  ts TIMESTAMP,
  dur DURATION,
  root_utid JOINID(thread.id)
) AS
WITH
  -- Critical-path frames for this root in this window.
  _scoped_cp AS MATERIALIZED (
    SELECT
      cr.ts,
      cr.dur,
      g.utid
    FROM _critical_path_by_roots!(
      _intervals_to_roots!(
        (SELECT $root_utid AS utid, $ts AS ts, $dur AS dur),
        _wakeup_graph),
      _wakeup_graph) AS cr
    JOIN _wakeup_graph AS g
      ON g.id = cr.id
    WHERE
      cr.dur > 0 AND cr.ts < $ts + $dur AND cr.ts + cr.dur > $ts
  ),
  -- Blocker thread_state × flat-slice for the utids the CP touches.
  -- `utid IN (subquery)` is what triggers the SPAN_LEFT_JOIN's
  -- per-partition push-down; a `JOIN … USING (utid)` instead caused
  -- the engine to scan all partitions (~4× slower in microbenchmarks).
  _scoped_blocker_th_slice AS MATERIALIZED (
    SELECT
      sp.thread_state_id,
      sp.ts,
      sp.dur,
      sp.utid,
      sp.state,
      sp.function,
      sp.cpu,
      sp.io_wait,
      sp.slice_id,
      sp.slice_depth
    FROM _span_thread_state_slice_sp AS sp
    WHERE
      sp.utid IN (
        SELECT DISTINCT
          utid
        FROM _scoped_cp
      )
      AND sp.dur > 0
      AND sp.ts < $ts + $dur
      AND sp.ts + sp.dur > $ts
  ),
  -- Inner intersection of local CP × blocker thread_state-slice. We
  -- open-code the join with overlap predicates rather than use
  -- `_interval_intersect!`: empirically the macro path was ~40×
  -- slower on whole-trace queries (the join-back to recover columns
  -- interacts badly with the macro's twin evaluation, even with
  -- MATERIALIZED inputs).
  _scoped_cp_th_slice AS MATERIALIZED (
    SELECT
      max(cp.ts, bts.ts) AS ts,
      min(cp.ts + cp.dur, bts.ts + bts.dur) - max(cp.ts, bts.ts) AS dur,
      bts.thread_state_id,
      bts.utid,
      bts.state,
      bts.function,
      bts.cpu,
      bts.io_wait,
      bts.slice_id,
      bts.slice_depth
    FROM _scoped_cp AS cp
    JOIN _scoped_blocker_th_slice AS bts
      ON bts.utid = cp.utid AND bts.ts < cp.ts + cp.dur AND bts.ts + bts.dur > cp.ts
  ),
  -- Self thread_state × flat-slice for `$root_utid` in the window.
  -- The SPAN_LEFT_JOIN keeps thread_state rows even when no slice
  -- overlaps (the original `_self_view` semantics).
  _scoped_self AS MATERIALIZED (
    SELECT
      sp.id AS self_thread_state_id,
      sp.slice_id AS self_slice_id,
      sp.ts,
      sp.dur,
      sp.state AS self_state,
      sp.blocked_function AS self_function,
      sp.cpu AS self_cpu,
      sp.io_wait AS self_io_wait,
      sp.depth AS self_slice_depth
    FROM _self_sp AS sp
    WHERE
      sp.utid = $root_utid AND sp.dur > 0 AND sp.ts < $ts + $dur AND sp.ts + sp.dur > $ts
  )
-- Replaces `_self_and_critical_path_sp WHERE root_utid = $root_utid`
-- with an open-coded interval intersection of the two local sides.
-- Both are implicitly partitioned by `root_utid = $root_utid`. Output
-- ts is clipped to the query window for parity with the prior
-- `max(ts, $ts) / min(ts + dur, $ts + $dur)` projection.
SELECT
  self.self_thread_state_id,
  self.self_state,
  self.self_slice_id,
  self.self_slice_depth,
  self.self_function,
  self.self_io_wait,
  cps.thread_state_id,
  cps.state,
  cps.function,
  cps.io_wait,
  cps.slice_id,
  cps.slice_depth,
  cps.cpu,
  cps.utid,
  max(self.ts, cps.ts, $ts) AS ts,
  min(self.ts + self.dur, cps.ts + cps.dur, $ts + $dur) - max(self.ts, cps.ts, $ts) AS dur,
  $root_utid AS root_utid
FROM _scoped_self AS self
JOIN _scoped_cp_th_slice AS cps
  ON cps.ts < self.ts + self.dur AND cps.ts + cps.dur > self.ts
WHERE
  min(self.ts + self.dur, cps.ts + cps.dur, $ts + $dur) > max(self.ts, cps.ts, $ts);

-- Wide-row context for the critical path of `$root_utid` over the
-- query window. One row per maximal `(ts, dur)` interval where every
-- self and blocker attribute is constant (the same intervals
-- `_critical_path_relevant_spans` produces, with thread / process /
-- slice names joined in). Designed for UI tracks and pprof to consume
-- without parsing typed-prefix strings: each axis is its own column.
--
-- Slice columns carry the *leaf* of the flat-slice stack only. For the
-- ancestor stack on either side, see `_critical_path_self_slice_stack`
-- and `_critical_path_blocker_slice_stack`.
CREATE PERFETTO FUNCTION _critical_path_context(
    -- The blocked thread we are computing the critical path for.
    root_utid JOINID(thread.id),
    -- Window start.
    ts TIMESTAMP,
    -- Window duration.
    dur DURATION
)
RETURNS TABLE (
  -- Start of this critical-path interval, clipped to the query window.
  ts TIMESTAMP,
  -- Duration of this critical-path interval.
  dur DURATION,
  -- The blocked thread (== input `root_utid`).
  root_utid JOINID(thread.id),
  -- thread_state.id of `root_utid` over this interval.
  self_thread_state_id LONG,
  -- thread_state.state of `root_utid` over this interval (e.g. 'S', 'D', 'R').
  self_state STRING,
  -- thread_state.blocked_function — the kernel function the thread is
  -- waiting in (e.g. 'futex_wait_queue_me'), NULL when running.
  self_function STRING,
  -- thread_state.io_wait of `root_utid` over this interval.
  self_io_wait LONG,
  -- Leaf slice on `root_utid` at this time, NULL if no slice is active.
  self_slice_id LONG,
  -- Name of the leaf self slice.
  self_slice_name STRING,
  -- Depth of the leaf self slice in the original (un-flattened) stack.
  self_slice_depth LONG,
  -- The thread that was on-CPU during `root_utid`'s wait at this
  -- interval (the on-CPU blocker in the wakeup chain).
  blocker_utid JOINID(thread.id),
  -- thread.name of the blocker.
  blocker_thread_name STRING,
  -- process.name of the blocker.
  blocker_process_name STRING,
  -- thread_state.id of the blocker over this interval.
  blocker_thread_state_id LONG,
  -- thread_state.state of the blocker over this interval.
  blocker_state STRING,
  -- thread_state.blocked_function of the blocker (NULL when running).
  blocker_function STRING,
  -- thread_state.io_wait of the blocker over this interval.
  blocker_io_wait LONG,
  -- CPU the blocker was running on, NULL when not running.
  blocker_cpu LONG,
  -- Leaf slice on the blocker at this time.
  blocker_slice_id LONG,
  -- Name of the leaf blocker slice.
  blocker_slice_name STRING,
  -- Depth of the leaf blocker slice in the original (un-flattened) stack.
  blocker_slice_depth LONG
) AS
SELECT
  rs.ts,
  rs.dur,
  rs.root_utid,
  rs.self_thread_state_id,
  rs.self_state,
  rs.self_function,
  rs.self_io_wait,
  rs.self_slice_id,
  self_sl.name AS self_slice_name,
  rs.self_slice_depth,
  rs.utid AS blocker_utid,
  blocker_th.name AS blocker_thread_name,
  blocker_proc.name AS blocker_process_name,
  rs.thread_state_id AS blocker_thread_state_id,
  rs.state AS blocker_state,
  rs.function AS blocker_function,
  rs.io_wait AS blocker_io_wait,
  rs.cpu AS blocker_cpu,
  rs.slice_id AS blocker_slice_id,
  blocker_sl.name AS blocker_slice_name,
  rs.slice_depth AS blocker_slice_depth
FROM _critical_path_relevant_spans($root_utid, $ts, $dur) AS rs
LEFT JOIN slice AS self_sl
  ON self_sl.id = rs.self_slice_id
LEFT JOIN slice AS blocker_sl
  ON blocker_sl.id = rs.slice_id
LEFT JOIN thread AS blocker_th
  ON blocker_th.utid = rs.utid
LEFT JOIN process AS blocker_proc
  ON blocker_proc.upid = blocker_th.upid;

-- Ancestor slice stack for the *self* (blocked) side at each
-- critical-path interval. One row per (ts, dur, ancestor depth) — for
-- intervals where `root_utid` has an active slice, this returns the
-- slice and every ancestor up to the root. `stack_depth` is the
-- ancestor's depth in the original (un-flattened) slice stack, so
-- consumers can stack-display from `stack_depth = 0` (root) outward.
CREATE PERFETTO FUNCTION _critical_path_self_slice_stack(
    root_utid JOINID(thread.id),
    ts TIMESTAMP,
    dur DURATION
)
RETURNS TABLE (
  -- Start of the critical-path interval this stack frame covers,
  -- clipped to the query window.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur DURATION,
  -- The blocked thread (== input `root_utid`).
  root_utid JOINID(thread.id),
  -- slice.id of this ancestor (or the leaf, when `stack_depth` equals
  -- the leaf's depth).
  slice_id LONG,
  -- slice.name of this ancestor.
  slice_name STRING,
  -- Depth of this ancestor in the original (un-flattened) slice stack.
  -- 0 = root, increasing toward the leaf.
  stack_depth LONG
) AS
WITH
  ctx AS MATERIALIZED (
    SELECT
      *
    FROM _critical_path_context($root_utid, $ts, $dur)
    WHERE
      self_slice_id IS NOT NULL
  )
SELECT
  ctx.ts,
  ctx.dur,
  ctx.root_utid,
  anc.id AS slice_id,
  anc.name AS slice_name,
  anc.depth AS stack_depth
FROM ctx, ancestor_slice(ctx.self_slice_id) AS anc
WHERE
  anc.dur != -1
UNION ALL
SELECT
  ctx.ts,
  ctx.dur,
  ctx.root_utid,
  ctx.self_slice_id AS slice_id,
  ctx.self_slice_name AS slice_name,
  ctx.self_slice_depth AS stack_depth
FROM ctx;

-- Same as `_critical_path_self_slice_stack` but for the on-CPU blocker
-- at each critical-path interval. The blocker switches as the wakeup
-- chain advances; this returns the active blocker's slice stack at
-- each step.
CREATE PERFETTO FUNCTION _critical_path_blocker_slice_stack(
    root_utid JOINID(thread.id),
    ts TIMESTAMP,
    dur DURATION
)
RETURNS TABLE (
  -- Start of the critical-path interval this stack frame covers,
  -- clipped to the query window.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur DURATION,
  -- The blocked thread (== input `root_utid`).
  root_utid JOINID(thread.id),
  -- The blocker thread that was on-CPU during this interval.
  blocker_utid JOINID(thread.id),
  -- slice.id of this ancestor (or the leaf).
  slice_id LONG,
  -- slice.name of this ancestor.
  slice_name STRING,
  -- Depth of this ancestor in the blocker's original slice stack.
  -- 0 = root, increasing toward the leaf.
  stack_depth LONG
) AS
WITH
  ctx AS MATERIALIZED (
    SELECT
      *
    FROM _critical_path_context($root_utid, $ts, $dur)
    WHERE
      blocker_slice_id IS NOT NULL
  )
SELECT
  ctx.ts,
  ctx.dur,
  ctx.root_utid,
  ctx.blocker_utid,
  anc.id AS slice_id,
  anc.name AS slice_name,
  anc.depth AS stack_depth
FROM ctx, ancestor_slice(ctx.blocker_slice_id) AS anc
WHERE
  anc.dur != -1
UNION ALL
SELECT
  ctx.ts,
  ctx.dur,
  ctx.root_utid,
  ctx.blocker_utid,
  ctx.blocker_slice_id AS slice_id,
  ctx.blocker_slice_name AS slice_name,
  ctx.blocker_slice_depth AS stack_depth
FROM ctx;

-- pprof aggregation of the critical path. Builds the per-interval stack
-- from `_critical_path_context` columns + (optionally)
-- `_critical_path_blocker_slice_stack`, then folds via `cat_stacks`
-- and aggregates with `experimental_profile`. Each frame is a typed
-- column value (no `'process_name: ' || ...` string smashing), so the
-- resulting flame graph aggregates correctly: identical
-- `(blocker_thread, blocker_state, blocker_slice_path)` paths land on
-- the same leaf instead of being fragmented by accidental columns
-- like `cpu` or `io_wait`.
--
-- Stack ordering (outer → inner, matching pprof convention where the
-- inner frame is "where the time was spent"):
--
--   graph_title
--    └─ self thread_state          (e.g. 'S', 'D', 'R')
--        └─ self kernel function   (if `enable_self_function` and non-NULL)
--            └─ blocker process    (if `enable_blocker_process`)
--                └─ blocker thread (if `enable_blocker_thread`)
--                    └─ blocker thread_state
--                        └─ blocker kernel function (if blocker in kernel)
--                            └─ blocker slice stack (root → leaf,
--                                if `enable_blocker_slice_stack`)
CREATE PERFETTO FUNCTION _critical_path_pprof(
    -- Descriptive name shown as the root frame of every sample.
    graph_title STRING,
    -- The blocked thread we are computing the critical path for.
    root_utid JOINID(thread.id),
    -- Window start.
    ts TIMESTAMP,
    -- Window duration.
    dur DURATION,
    -- Whether to add the blocker's process name as a frame.
    enable_blocker_process LONG,
    -- Whether to add the blocker's thread name as a frame.
    enable_blocker_thread LONG,
    -- Whether to expand the blocker's slice stack (root → leaf) inline.
    enable_blocker_slice_stack LONG,
    -- Whether to add the self-side blocked_function as a frame.
    enable_self_function LONG
)
RETURNS TABLE (
  -- pprof bytes. `experimental_profile` uses 'duration' / 'ns' values.
  pprof BYTES
) AS
WITH
  ctx AS MATERIALIZED (
    SELECT
      *
    FROM _critical_path_context($root_utid, $ts, $dur)
  ),
  -- Per-(ts) frames at synthetic depths. Depth 0 = graph title (the
  -- outermost frame); depth grows inward toward the leaf. Frames whose
  -- value would be NULL are omitted; depths are then re-densified
  -- below so the recursive cat_stacks walk has no gaps.
  frames AS (
    SELECT
      ts,
      dur,
      0 AS frame_order,
      $graph_title AS name
    FROM ctx
    UNION ALL
    SELECT
      ts,
      dur,
      1,
      'thread_state: ' || self_state
    FROM ctx
    UNION ALL
    SELECT
      ts,
      dur,
      2,
      'kernel function: ' || self_function
    FROM ctx
    WHERE
      $enable_self_function AND self_function IS NOT NULL
    UNION ALL
    SELECT
      ts,
      dur,
      3,
      'blocking process_name: ' || blocker_process_name
    FROM ctx
    WHERE
      $enable_blocker_process AND blocker_process_name IS NOT NULL
    UNION ALL
    SELECT
      ts,
      dur,
      4,
      'blocking thread_name: ' || blocker_thread_name
    FROM ctx
    WHERE
      $enable_blocker_thread AND blocker_thread_name IS NOT NULL
    UNION ALL
    SELECT
      ts,
      dur,
      5,
      'blocking thread_state: ' || blocker_state
    FROM ctx
    UNION ALL
    SELECT
      ts,
      dur,
      6,
      'blocking kernel function: ' || blocker_function
    FROM ctx
    WHERE
      blocker_function IS NOT NULL
    UNION ALL
    SELECT
      ts,
      dur,
      -- Slice stack frames go after the fixed frames (offset 7),
      -- ordered root → leaf via `stack_depth`.
      7 + stack_depth,
      slice_name
    FROM _critical_path_blocker_slice_stack($root_utid, $ts, $dur)
    WHERE
      $enable_blocker_slice_stack
  ),
  -- Re-densify `frame_order` per-(ts) into a contiguous `stack_depth`
  -- starting at 0, so the recursive walk can hop parent → child via
  -- `stack_depth + 1`. dur is converted to *self* time (full dur at
  -- the leaf, 0 at non-leaf frames) so the pprof aggregator does not
  -- double-count the same interval at every level of the stack.
  stack AS MATERIALIZED (
    SELECT
      ts,
      dur - coalesce(lead(dur) OVER (PARTITION BY ts ORDER BY frame_order), 0) AS dur,
      name,
      row_number() OVER (PARTITION BY ts ORDER BY frame_order) - 1 AS stack_depth
    FROM frames
  ),
  -- Walk parent → child building cumulative cat_stacks.
  parent AS (
    SELECT
      ts,
      dur,
      stack_depth,
      cat_stacks(name) AS stack
    FROM stack
    WHERE
      stack_depth = 0
    UNION ALL
    SELECT
      child.ts,
      child.dur,
      child.stack_depth,
      cat_stacks(parent.stack, child.name) AS stack
    FROM stack AS child
    JOIN parent
      ON parent.ts = child.ts AND child.stack_depth = parent.stack_depth + 1
  )
SELECT
  experimental_profile(stack, 'duration', 'ns', dur) AS pprof
FROM parent;
