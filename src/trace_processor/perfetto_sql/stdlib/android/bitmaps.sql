--
-- Copyright 2025 The Android Open Source Project
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

INCLUDE PERFETTO MODULE counters.intervals;

INCLUDE PERFETTO MODULE intervals.intersect;

CREATE PERFETTO MACRO _android_bitmap_counter_macro(name Expr)
RETURNS TableOrSubquery
AS (
  SELECT
    id,
    track_id,
    ts,
    dur,
    track_id,
    value
  FROM counter_leading_intervals!((
    SELECT
      c.id,
      c.track_id,
      c.ts,
      c.value
    FROM counter AS c
JOIN process_counter_track AS pct ON pct.id = c.track_id
    WHERE pct.name = $name
  )) AS intervals
);

-- Provides a timeseries of "Bitmap Memory" counter for each process, which
-- is useful for retrieving the total memory used by bitmaps by an application over time.
--
-- To populate this table, tracing must be enabled with the "view" atrace
-- category.
CREATE PERFETTO TABLE android_bitmap_memory(
  -- ID of the row in the underlying counter table.
  id ID(counter.id),
  -- Upid of the process.
  upid JOINID(process.upid),
  -- Timestamp of the start of the interval.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur DURATION,
  -- Duration of the interval.
  track_id JOINID(counter.track_id),
  -- Memory consumed by bitmaps in bytes.
  value LONG
)
AS
SELECT c.id, upid, ts, dur, track_id, value
FROM _android_bitmap_counter_macro!('Bitmap Memory') AS c
JOIN process_counter_track AS pct
  ON pct.id = c.track_id
ORDER BY
  c.id;

-- Provides a timeseries of "Bitmap Count" counter for each process, which
-- is useful for retrieving the number of bitmaps used by an application over time.
--
-- To populate this table, tracing must be enabled with the "view" atrace
-- category.
CREATE PERFETTO TABLE android_bitmap_count(
  -- ID of the row in the underlying counter table.
  id ID(counter.id),
  -- Upid of the process.
  upid JOINID(process.upid),
  -- Timestamp of the start of the interval.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur DURATION,
  -- Duration of the interval.
  track_id JOINID(counter.track_id),
  -- Number of allocated bitmaps.
  value LONG
)
AS
SELECT c.id, upid, ts, dur, track_id, value
FROM _android_bitmap_counter_macro!('Bitmap Count') AS c
JOIN process_counter_track AS pct
  ON pct.id = c.track_id
ORDER BY
  c.id;

-- Provides a timeseries of bitmap-related counters for each process, which
-- is useful for understanding an application's bitmap usage over time.
--
-- To populate this table, tracing must be enabled with the "view" atrace
-- category.
CREATE PERFETTO TABLE android_bitmap_counters_per_process(
  -- Upid of the process.
  upid JOINID(process.upid),
  -- Name of the process.
  process_name STRING,
  -- Timestamp of the start of the interval.
  ts TIMESTAMP,
  -- Duration of the interval.
  dur DURATION,
  -- Memory consumed by bitmaps in bytes.
  bitmap_memory LONG,
  -- Number of allocated bitmaps.
  bitmap_count LONG,
  -- ID of the row in the underlying counter table.
  bitmap_memory_id JOINID(counter.id),
  -- ID of the row in the underlying counter table.
  bitmap_count_id JOINID(counter.id)
)
AS
SELECT
  p.upid,
  p.name AS process_name,
  c.ts,
  c.dur,
  abm.value AS bitmap_memory,
  abc.value AS bitmap_count,
  abm.id AS bitmap_memory_id,
  abc.id AS bitmap_count_id
-- TODO(lalitm): we have this interval intersect because as implemented today,
-- the bitmap memory and count counters are updated one after the
-- other *but* with slightly different timestamps. Ideally, we would remove
-- these "intermediate" intervals but that would require heuristics. So for now,
-- we just intersect the intervals together and retain the intermediate
-- intervals. Alternatively, if we had a way to actually timestamp both
-- counters at the same time, we could avoid this. We would need the Perfetto
-- SDK for that though.
FROM _interval_intersect!(
  (
    android_bitmap_memory,
    android_bitmap_count
  ),
  (upid)
) AS c
JOIN android_bitmap_memory AS abm
  ON c.id_0 = abm.id
JOIN android_bitmap_count AS abc
  ON c.id_1 = abc.id
JOIN process AS p USING (upid);

-- ---------------------------------------------------------------------------
-- android.graphics.Bitmap heap-graph analysis
-- ---------------------------------------------------------------------------
--
-- Surfaces the Java-side `mId` and `mSourceId` fields of every Bitmap
-- instance in an ART heap dump and decodes them into pid + pixel-storage-type
-- components (per frameworks/base/libs/hwui/hwui/Bitmap.cpp:122). `mId` is
-- a process-monotonic instance counter (never a dedup key); `mSourceId`
-- identifies the parcel sender for cross-process Bitmaps and is the only
-- field with cross-instance semantics. See
-- ui/src/plugins/com.android.HeapDumpExplorer/RESEARCH.md for the full
-- background, dedup taxonomy, and source-line citations.
--
-- Scalar fields require an HPROF dump (heap_graph_primitive populated);
-- proto-format heap graphs leave them NULL.

-- Resolves the (sender pid, heap dump timestamp) of a parcel-received Bitmap
-- to a `process.upid` by intersecting against the trace's `process` table
-- lifetime ranges. Necessary because pids are reused across the OS lifecycle:
-- the same numeric pid may identify different processes at different points
-- in a long trace, but a (pid, ts) pair is unambiguous within process
-- start_ts..end_ts windows.
--
-- Returns NULL when `pid` was not observed in the trace's process table at
-- `at_ts` (typical for HPROF-only traces, which contain no process info,
-- and for senders that exited before the trace started).
--
-- Logic mirrors `android.freezer._pid_to_upid` deliberately rather than
-- depending on it: this module is about Bitmap heap-graph analysis and a
-- runtime dependency on the freezer module would couple two unrelated
-- concerns.
CREATE PERFETTO FUNCTION _android_bitmap_resolve_sender_upid(
  -- Pid of the parcel sender, decoded from a non-NULL `mSourceId`.
  pid LONG,
  -- Timestamp of the heap dump that observed the receiver Bitmap.
  at_ts TIMESTAMP
)
-- The `process.upid` whose lifetime covers `at_ts`, or NULL if no match.
RETURNS LONG
AS
WITH
  process_lifetime AS (
    SELECT
      pid,
      upid,
      coalesce(start_ts, trace_start()) AS start_ts,
      coalesce(end_ts, trace_end()) AS end_ts
    FROM process
  )
SELECT upid
FROM process_lifetime
WHERE
  pid = $pid
  AND $at_ts BETWEEN start_ts AND end_ts
ORDER BY
  upid DESC
LIMIT 1;

-- Decodes a Bitmap PixelStorageType integer (0..3) into its enum name as
-- declared in `frameworks/base/libs/hwui/hwui/Bitmap.h:39-44`. Returns NULL
-- for inputs outside the known range.
CREATE PERFETTO FUNCTION _android_bitmap_storage_type_name(
  -- Raw PixelStorageType integer.
  storage_type LONG
)
-- Stable name for the PixelStorageType.
RETURNS STRING
AS
SELECT
  CASE $storage_type
    WHEN 0 THEN 'wrapped_pixel_ref'
    WHEN 1 THEN 'heap'
    WHEN 2 THEN 'ashmem'
    WHEN 3 THEN 'hardware'
    ELSE NULL
  END;

-- Per-Bitmap-object view over the heap graph, with `mId` and `mSourceId`
-- decoded into their pid / storage-type components and (for parcel-received
-- Bitmaps) the sender resolved to a `upid` and process name at the heap
-- dump's timestamp.
--
-- One row per `android.graphics.Bitmap` instance per heap dump. Scalar
-- columns derived from `heap_graph_primitive` (width/height/density/...)
-- are populated only when the trace is an ART HPROF dump
-- (`heap_graph_object_data` populated); on proto-format heap graphs
-- (e.g. `android.java_hprof` data source) they are NULL and the row still
-- appears so callers can fall back to size-only analysis.
CREATE PERFETTO TABLE android_heap_graph_bitmaps(
  -- heap_graph_object.id of the Bitmap instance.
  object_id JOINID(heap_graph_object.id),
  -- Process upid that owns the Bitmap.
  upid JOINID(process.upid),
  -- Heap dump timestamp. A trace may contain multiple dumps; this column
  -- disambiguates them.
  graph_sample_ts TIMESTAMP,
  -- Class name as recorded in heap_graph_class (deobfuscated when a
  -- mapping is available).
  type_name STRING,
  -- Pixel width (mWidth). NULL on proto heap graphs.
  width LONG,
  -- Pixel height (mHeight). NULL on proto heap graphs.
  height LONG,
  -- Pixel density in dpi (mDensity). NULL on proto heap graphs.
  density LONG,
  -- True when the Bitmap has been recycled (mRecycled). NULL on proto
  -- heap graphs.
  recycled BOOL,
  -- Native handle pointing to BitmapWrapper* (mNativePtr). Process-local
  -- and not a content key. NULL on proto heap graphs.
  native_ptr LONG,
  -- Process-monotonic Bitmap instance identifier (mId), encoded as
  -- `pid * 10^7 + storage_type * 10^6 + counter%10^6` per
  -- frameworks/base/libs/hwui/hwui/Bitmap.cpp:122. See bitmap_pid /
  -- bitmap_storage_type for the decoded components. NOT a dedup key:
  -- every Bitmap allocation in a process gets a fresh value.
  bitmap_id LONG,
  -- Allocating process pid decoded from bitmap_id. Equals the pid of
  -- `upid`'s process for valid traces.
  bitmap_pid LONG,
  -- Pixel-memory storage backing decoded from bitmap_id. One of
  -- 'wrapped_pixel_ref', 'heap', 'ashmem', 'hardware'. NULL when
  -- bitmap_id is NULL.
  bitmap_storage_type STRING,
  -- Cross-process source identifier (mSourceId), canonicalised: the raw
  -- sentinel -1 used by Bitmap.java for "no source" is mapped to NULL.
  -- When non-NULL, equals the sender's mId at the time of
  -- Bitmap.writeToParcel.
  source_id LONG,
  -- Sender process pid decoded from source_id. NULL when source_id is
  -- NULL.
  source_pid LONG,
  -- Sender's pixel storage type decoded from source_id. NULL when
  -- source_id is NULL.
  source_storage_type STRING,
  -- Sender's upid at graph_sample_ts, resolved via
  -- _android_bitmap_resolve_sender_upid. NULL when source_id is NULL, or
  -- when the sender pid is not present in the trace's process table at
  -- the dump's timestamp (typical for HPROF-only traces with no
  -- linux.process_stats data source captured alongside).
  source_upid JOINID(process.upid),
  -- Sender's process name at graph_sample_ts. NULL when source_upid is
  -- NULL.
  source_process_name STRING,
  -- Java self_size of the Bitmap object.
  self_size LONG,
  -- Native size attributed to the Bitmap. Includes the pixel buffer when
  -- it lives on the malloc heap (storage='heap'); near-zero for ashmem
  -- and hardware backings since those pixels live outside the Java heap.
  native_size LONG,
  -- Whether the Bitmap is reachable from a GC root.
  reachable BOOL
)
AS
WITH
  bitmap_objects AS (
    SELECT
      o.id AS object_id,
      o.upid,
      o.graph_sample_ts,
      o.self_size,
      o.native_size,
      o.reachable,
      od.field_set_id,
      coalesce(c.deobfuscated_name, c.name) AS type_name
    FROM heap_graph_object AS o
    JOIN heap_graph_class AS c
      ON o.type_id = c.id
    LEFT JOIN heap_graph_object_data AS od
      ON o.object_data_id = od.id
    WHERE
      c.name = 'android.graphics.Bitmap'
      OR c.deobfuscated_name = 'android.graphics.Bitmap'
  ),
  bitmap_fields AS (
    -- One row per Bitmap object, with each scalar field pivoted out of
    -- heap_graph_primitive. Field names are FQN-qualified
    -- ('android.graphics.Bitmap.mWidth' etc.); no parent class of Bitmap
    -- declares these fields, so the FQN match is unambiguous.
    SELECT
      b.object_id,
      b.upid,
      b.graph_sample_ts,
      b.type_name,
      b.self_size,
      b.native_size,
      b.reachable,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mWidth' THEN p.int_value
        END
      ) AS width,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mHeight' THEN p.int_value
        END
      ) AS height,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mDensity' THEN p.int_value
        END
      ) AS density,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mRecycled' THEN p.bool_value
        END
      ) AS recycled,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mNativePtr' THEN p.long_value
        END
      ) AS native_ptr,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mId' THEN p.long_value
        END
      ) AS bitmap_id,
      MAX(
        CASE
          WHEN p.field_name = 'android.graphics.Bitmap.mSourceId' THEN p.long_value
        END
      ) AS source_id_raw
    FROM bitmap_objects AS b
    LEFT JOIN heap_graph_primitive AS p
      ON p.field_set_id = b.field_set_id
    GROUP BY
      b.object_id
  ),
  bitmap_fields_decoded AS (
    -- Decode pid + storage type out of the encoded ids, canonicalise the -1
    -- sentinel for source_id so downstream JOINs behave naturally, and resolve
    -- the sender's upid once (it's used both as the output column and as the
    -- JOIN key into `process` for the sender name).
    SELECT
      object_id,
      upid,
      graph_sample_ts,
      type_name,
      width,
      height,
      density,
      recycled,
      native_ptr,
      bitmap_id,
      cast_int!(bitmap_id / 10000000) AS bitmap_pid,
      _android_bitmap_storage_type_name(
        cast_int!((bitmap_id % 10000000) / 1000000)
      ) AS bitmap_storage_type,
      CASE
        WHEN source_id_raw = -1
        OR source_id_raw IS NULL THEN NULL
        ELSE source_id_raw
      END AS source_id,
      CASE
        WHEN source_id_raw = -1
        OR source_id_raw IS NULL THEN NULL
        ELSE cast_int!(source_id_raw / 10000000)
      END AS source_pid,
      CASE
        WHEN source_id_raw = -1
        OR source_id_raw IS NULL THEN NULL
        ELSE _android_bitmap_storage_type_name(
          cast_int!((source_id_raw % 10000000) / 1000000)
        )
      END AS source_storage_type,
      CASE
        WHEN source_id_raw = -1
        OR source_id_raw IS NULL THEN NULL
        ELSE _android_bitmap_resolve_sender_upid(
          cast_int!(source_id_raw / 10000000),
          graph_sample_ts
        )
      END AS source_upid,
      self_size,
      native_size,
      reachable
    FROM bitmap_fields
  )
SELECT
  b.object_id,
  b.upid,
  b.graph_sample_ts,
  b.type_name,
  b.width,
  b.height,
  b.density,
  b.recycled,
  b.native_ptr,
  b.bitmap_id,
  b.bitmap_pid,
  b.bitmap_storage_type,
  b.source_id,
  b.source_pid,
  b.source_storage_type,
  b.source_upid,
  src_proc.name AS source_process_name,
  b.self_size,
  b.native_size,
  b.reachable
FROM bitmap_fields_decoded AS b
LEFT JOIN process AS src_proc
  ON src_proc.upid = b.source_upid;
