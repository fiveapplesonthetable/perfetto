# Generating pprof from any tree

PerfettoSQL ships a `PROFILE_FROM_TREE` aggregate that converts any
`(id, parent_id, frame_name, value)` hierarchy into a serialized
[pprof Profile](https://github.com/google/pprof/blob/main/proto/profile.proto).
A thin stdlib layer (`pprof.from_tree`) wraps it on top of the existing
`std.trees.*` operators (`_tree_from_table`, `_tree_filter`,
`_tree_propagate_down`) so all pprof queries share one composable
pipeline:

```
              raw rows                            tree pointer
  ┌───────────────────────────┐    _tree_from_table!    ┌──────────┐
  │ (id, parent_id, name,     │ ────────────────────► │ TREE_PTR │
  │  value, …)                │                        └────┬─────┘
  └───────────────────────────┘                             │
                                            optional ┌─────┴────────┐
                                          composition │ _tree_filter │
                                                      │ _tree_propagate_down
                                                      └─────┬────────┘
                                                            │
                                            _pprof_from_tree!│
                                                            ▼
                                                      pprof bytes
```

The Perfetto UI exposes the same primitive in two places:

- A permanent **Download as pprof** button in the top-right of every
  flamegraph (heap profile, perf samples, java heap, slice flamegraph,
  and any user-driven flamegraph).
- An **Add flamegraph** popup on every data-grid surface (SQL query
  results panel, SQL table tab) that lets the user pick the
  `id`/`parent_id`/`name`/`value` columns and the metric `sample_type`
  / `unit`, then opens a flamegraph tab driven by those columns. The
  resulting tab inherits the toolbar Download button.

## SQL surface

Two layers, with composition flowing through `std.trees.*`:

```sql
-- Layer 1: raw aggregate, no stdlib dependency.
SELECT PROFILE_FROM_TREE(
  id,         -- INTEGER, unique per row
  parent_id,  -- INTEGER NULL, NULL marks a root
  name,       -- TEXT NULL, frame label
  value,      -- INTEGER NULL, rows with NULL or value <= 0 emit
              -- no Sample but remain available as ancestors
  sample_type,-- TEXT, e.g. 'space', 'allocations', 'wall'
  unit        -- TEXT, e.g. 'bytes', 'count', 'nanoseconds'
)
FROM tree;

-- Layer 2: stdlib macro for queries that compose with std.trees.*.
INCLUDE PERFETTO MODULE pprof.from_tree;
SELECT _pprof_from_tree!(
  _tree_from_table!(
    (SELECT id, parent_id, name, dur AS value
     FROM slice WHERE dur > 0),
    (name, value)),
  name, value,        -- column names inside the tree pointer
  'wall', 'nanoseconds');
```

Both return a BLOB of raw (uncompressed) pprof Profile bytes.

### Errors

The aggregate fails the query (with a clear message) when:

- two rows share the same `id`
- a non-NULL `parent_id` references an `id` not present in the input
- the parent chain of a sample contains a cycle

## Recipes

Each recipe below runs end-to-end on the trace fixtures in
`docs/analysis/pprof-from-tree-traces/` (heap dump, callstack samples,
message-handler atrace, java heap dominator). Save the query to a file
and run:

```sh
out/linux/trace_processor_shell -Q query.sql trace.pftrace > /tmp/out.hex
python3 -c "import re,sys; \
  d=open('/tmp/out.hex').read(); \
  open('/tmp/out.pb','wb').write(bytes.fromhex(re.sub(r'[^0-9A-Fa-f]','',
    [l for l in d.splitlines() if l.startswith('\"')][1].strip('\"'))))"
pprof -text /tmp/out.pb
```

### 1. Native heap dump (heapprofd)

```sql
INCLUDE PERFETTO MODULE pprof.from_tree;

SELECT _pprof_from_tree!(
  _tree_from_table!(
    (SELECT
       c.id        AS id,
       c.parent_id AS parent_id,
       COALESCE(f.name, '<anon>') AS name,
       COALESCE(
         (SELECT SUM(size) FROM heap_profile_allocation a
          WHERE a.callsite_id = c.id AND a.size > 0), 0) AS value
     FROM stack_profile_callsite c
     JOIN stack_profile_frame    f ON f.id = c.frame_id),
    (name, value)),
  name, value, 'space', 'bytes');
```

`pprof -text` of the resulting profile (system_server heap dump from
cuttlefish):

```
Type: space
Showing nodes accounting for 42kB, 100% of 42kB total
      flat  flat%   sum%        cum   cum%
      42kB   100%   100%       42kB   100%  malloc
         0     0%   100%       42kB   100%  __pthread_start
         0     0%   100%       14kB 33.33%  android::BinderObserver::flushStats
         0     0%   100%       10kB 23.81%  android::BinderStatsCollector::consumeData
```

### 2. Callstack sampling (linux.perf)

```sql
INCLUDE PERFETTO MODULE pprof.from_tree;

SELECT _pprof_from_tree!(
  _tree_from_table!(
    (SELECT
       c.id        AS id,
       c.parent_id AS parent_id,
       COALESCE(f.name, '<unknown>') AS name,
       COALESCE(
         (SELECT COUNT(*) FROM perf_sample p
          WHERE p.callsite_id = c.id), 0) AS value
     FROM stack_profile_callsite c
     JOIN stack_profile_frame    f ON f.id = c.frame_id),
    (name, value)),
  name, value, 'samples', 'count');
```

`pprof -text` of a 5s callstack-sampling capture targeting
`system_server` on cuttlefish:

```
Type: samples
Showing nodes accounting for 7, 100% of 7 total
      flat  flat%   sum%        cum   cum%
         2 28.57% 28.57%          2 28.57%  _raw_spin_unlock_irqrestore
         1 14.29% 42.86%          5 71.43%  do_syscall_64
         1 14.29% 57.14%          1 14.29%  art::InvokeVirtualOrInterfaceWithVarArgs
         1 14.29% 71.43%          1 14.29%  avc_has_perm_noaudit
```

### 3. Message-handler / atrace slices

Any track-event hierarchy (atrace, custom track events, Looper messages
emitted by `Trace.beginSection`) is already a tree: `slice.id` and
`slice.parent_id` form one. Wall-clock time is `slice.dur`:

```sql
INCLUDE PERFETTO MODULE pprof.from_tree;

SELECT _pprof_from_tree!(
  _tree_from_table!(
    (SELECT id, parent_id, name, dur AS value
     FROM slice WHERE dur > 0),
    (name, value)),
  name, value, 'wall', 'nanoseconds');
```

`pprof -text` of an atrace capture (system_server handler messages on
cuttlefish):

```
Type: wall
Showing nodes accounting for 537.84us, 100% of 537.84us total
      flat  flat%   sum%        cum   cum%
  244.28us 45.42% 45.42%   440.73us 81.94%  traverse network
  190.73us 35.46% 80.88%   190.73us 35.46%  drain scheduler
   31.85us  5.92% 86.80%    31.85us  5.92%  process inputs
   18.55us  3.45% 90.25%    18.55us  3.45%  com.android.systemui.statusbar.connectivity.CallbackHandler: …$$ExternalSyntheticLambda0
```

For a more focused view, drop slices below 1ms before emitting pprof:

```sql
SELECT _pprof_from_tree!(
  _tree_filter(
    _tree_from_table!(
      (SELECT id, parent_id, name, dur AS value FROM slice),
      (name, value)),
    _tree_where(_tree_constraint('value', '>', 1000000))),
  name, value, 'wall', 'nanoseconds');
```

### 4. Java heap dominator tree

The dominator tree of a Java heap is exposed by
`android.memory.heap_graph.dominator_tree`. Combine it with object
type names and self-sizes:

```sql
INCLUDE PERFETTO MODULE android.memory.heap_graph.dominator_tree;
INCLUDE PERFETTO MODULE pprof.from_tree;

SELECT _pprof_from_tree!(
  _tree_from_table!(
    (SELECT
       d.id            AS id,
       d.idom_id       AS parent_id,
       COALESCE(c.name, '<unknown>') AS name,
       o.self_size     AS value
     FROM heap_graph_dominator_tree d
     JOIN heap_graph_object        o USING (id)
     LEFT JOIN heap_graph_class    c ON c.id = o.type_id),
    (name, value)),
  name, value, 'space', 'bytes');
```

`pprof -text` of a 64MB Java heap dump from `system_server`:

```
Type: space
Showing nodes accounting for 114.31MB, 90.50% of 126.31MB total
Dropped 12426 nodes (cum <= 0.63MB)
      flat  flat%   sum%        cum   cum%
   60.86MB 48.18% 48.18%    60.86MB 48.18%  double[]
   11.78MB  9.32% 57.50%    13.05MB 10.33%  java.lang.Class
    8.87MB  7.03% 64.53%     8.87MB  7.03%  android.location.GnssAntennaInfo$PhaseCenterOffset
    7.61MB  6.02% 70.55%    68.46MB 54.20%  double[][]
    7.33MB  5.80% 76.35%     7.33MB  5.80%  java.lang.String
    5.07MB  4.01% 80.37%    86.20MB 68.25%  android.location.GnssAntennaInfo$Builder
    3.80MB  3.01% 83.38%    72.26MB 57.21%  android.location.GnssAntennaInfo$SphericalCorrections
```

## UI

### Download as pprof

The Perfetto Flamegraph widget renders a `download` icon button in its
toolbar (top-right of the filter bar). Clicking it serializes the
flamegraph's currently-rendered tree using the same pprof shape the
SQL aggregate produces and triggers a browser download named
`<metric>.pb`. The bytes can be inspected with:

```sh
go install github.com/google/pprof@latest
pprof -text downloaded.pb
```

The button is implemented entirely in TypeScript so it works without
re-querying the engine, and is byte-for-byte identical to what the
C++ aggregate would produce given the same input.

### Add flamegraph (every data grid)

Wherever the existing **Add debug track** popup is exposed (the SQL
query result panel, the SQL table tab), there is now a sibling
**Add flamegraph** popup. The form has a title field, dropdowns to
choose the `id` / `parent_id` / `name` / `value` columns from the
underlying query (auto-picked when columns of those names exist), and
two free-text fields for the metric `sample_type` and `unit`.

Submitting opens an ephemeral tab driven by the chosen columns; the
tab uses the same `Flamegraph` widget so the Download as pprof button
is available immediately.

## Verification

```sh
tools/gn gen out/linux
tools/ninja -C out/linux trace_processor_shell

out/linux/trace_processor_shell -Q query.sql /path/to/trace.pftrace \
  > /tmp/out.hex
# Decode hex to binary; see the Recipes section above for the snippet.
pprof -text /tmp/out.pb
```
