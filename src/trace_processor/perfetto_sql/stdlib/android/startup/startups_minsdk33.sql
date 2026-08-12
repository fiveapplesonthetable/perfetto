--
-- Copyright 2019 The Android Open Source Project
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

INCLUDE PERFETTO MODULE android.startup.startup_events;

CREATE PERFETTO VIEW _startup_async_events AS
SELECT ts, dur, cast_int!(SUBSTR(name, 19)) AS startup_id
FROM slice
WHERE
  name GLOB 'launchingActivity#*'
  AND dur > 0
  AND instr(name, ':') = 0;

CREATE PERFETTO VIEW _startup_complete_events AS
SELECT
  cast_int!(STR_SPLIT(completed, ':', 0)) AS startup_id,
  str_split(completed, ':', 2) AS package_name,
  CASE
    WHEN str_split(completed, ':', 1) = 'completed-hot' THEN 'hot'
    WHEN str_split(completed, ':', 1) = 'completed-warm' THEN 'warm'
    WHEN str_split(completed, ':', 1) = 'completed-cold' THEN 'cold'
    ELSE NULL
  END AS startup_type,
  min(ts)
FROM (
  SELECT ts, substr(name, 19) AS completed
  FROM slice
  WHERE
    dur = 0
    -- Originally completed was unqualified, but at some point we introduced
    -- the startup type as well
    AND name GLOB 'launchingActivity#*:completed*:*'
    AND NOT (name GLOB '*:completed-same-process:*')
)
GROUP BY
  1,
  2,
  3;

-- The "launchingActivity#" async slice spans the whole launch sequence, so when
-- a launch coalesces consecutive activities (a trampoline, or the platform's
-- same-uid coalescing) it covers the first activity's start through the last
-- activity's first frame. That makes a coalesced launch look as if it started at
-- the first activity's start. The per-package "launching: <pkg>" slice is
-- restarted for the launched package, so use it to re-anchor the startup to the
-- activity that actually completed it. A plain launch (no earlier "launching:"
-- slice in the span) keeps the async span, preserving the intent-resolution
-- prefix that precedes the "launching:" slice.
CREATE PERFETTO TABLE _startups_minsdk33 AS
WITH
  _async AS (
    SELECT
      startup_id,
      ts,
      ts + dur AS ts_end,
      package_name AS package,
      startup_type
    FROM _startup_async_events
    JOIN _startup_complete_events USING (startup_id)
  ),
  -- The launched package's own "launching:" slice within the async span (latest
  -- one, in case the package appears more than once).
  _pkg_launch AS (
    SELECT
      a.startup_id,
      le.ts,
      le.ts_end,
      row_number() OVER (PARTITION BY a.startup_id ORDER BY le.ts DESC) AS rn
    FROM _async AS a
    JOIN _startup_events AS le
      ON le.package_name = a.package
      AND le.ts >= a.ts
      AND le.ts < a.ts_end
  ),
  -- Earliest "launching:" slice in the async span; if the launched package's
  -- slice starts after this, an earlier activity was coalesced in.
  _first_launch AS (
    SELECT a.startup_id, min(le.ts) AS first_ts
    FROM _async AS a
    JOIN _startup_events AS le
      ON le.ts >= a.ts
      AND le.ts < a.ts_end
    GROUP BY
      a.startup_id
  ),
  _resolved AS (
    SELECT
      a.startup_id,
      iif(pl.ts IS NOT NULL AND pl.ts > fl.first_ts, pl.ts, a.ts) AS ts,
      iif(pl.ts IS NOT NULL AND pl.ts > fl.first_ts, pl.ts_end, a.ts_end) AS ts_end,
      a.package,
      a.startup_type
    FROM _async AS a
    LEFT JOIN _pkg_launch AS pl
      ON pl.startup_id = a.startup_id
      AND pl.rn = 1
    LEFT JOIN _first_launch AS fl
      ON fl.startup_id = a.startup_id
  )
SELECT startup_id, ts, ts_end, ts_end - ts AS dur, package, startup_type
FROM _resolved;
