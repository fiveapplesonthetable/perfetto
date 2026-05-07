# Batch Trace Processor

_Batch Trace Processor (BTP) is a Python library wrapping the
[Trace Processor](/docs/analysis/trace-processor.md): it allows fast (<1s)
interactive queries on large corpora — from a handful of traces to **tens of
thousands** with bounded memory and durable caching._

A short version: hand BTP a list of traces, get one or more pandas /
[Polars](https://pola.rs/) DataFrames back per query. The hard parts —
subprocess management, memory budgeting, retry / timeout / failure
reporting, durable result caching, and an optional HTTP/JSON server for
agents and UIs — are handled for you.

## Installation

BTP is part of the `perfetto` Python library:

```shell
pip3 install pandas              # required
pip3 install pyarrow             # required for the durable session cache
                                 # (sqlite3 is stdlib — no install needed)
pip3 install perfetto
pip3 install perfetto[polars]    # optional: Polars support
```

## Loading traces

The simplest way is to pass a list of file paths:

```python
from perfetto.batch_trace_processor.api import BatchTraceProcessor

files = [
  'traces/slow-start.pftrace',
  'traces/oom.pftrace',
  'traces/high-battery-drain.pftrace',
]
with BatchTraceProcessor(files) as btp:
  btp.query('...')
```

[glob](https://docs.python.org/3/library/glob.html) for whole directories:

```python
from perfetto.batch_trace_processor.api import BatchTraceProcessor

files = glob.glob('traces/*.pftrace')
with BatchTraceProcessor(files) as btp:
  btp.query('...')
```

Or supply per-trace metadata that flows through to query results,
filtering, and the failure log:

```python
from perfetto.batch_trace_processor.api import BatchTraceProcessor
from perfetto.batch_trace_processor.inputs import TracesWithMetadata

inputs = TracesWithMetadata([
  ('traces/run-001.pftrace', {'build': 'AOSP', 'device': 'pixel-7'}),
  ('traces/run-002.pftrace', {'build': 'AOSP', 'device': 'pixel-8'}),
  ('traces/run-003.pftrace', {'build': 'GMS',  'device': 'pixel-7'}),
])
with BatchTraceProcessor(inputs) as btp:
  df = btp.query_and_flatten('select count(*) as n from slice')
  pixel7 = df[df['device'] == 'pixel-7']  # metadata is materialised as columns
```

For URIs to remote sources (cloud storage, HTTP, etc.), see
[Trace URIs](#trace-uris) below.

NOTE: if you are a Googler, see
[go/perfetto-btp-load-internal](http://goto.corp.google.com/perfetto-btp-load-internal)
for Google-internal sources.

## Writing queries

### `query` — one DataFrame per trace

```python
>>> btp.query('select count(1) from slice')
[  count(1)
0  2092592,   count(1)
0   156071,   count(1)
0   121431]
```

### `query_and_flatten` — one merged DataFrame

```python
>>> btp.query_and_flatten('select count(1) from slice')
  count(1)
0  2092592
1   156071
2   121431
```

`query_and_flatten` adds metadata columns automatically. With
`TracesWithMetadata` above, `device` and `build` are part of the output.

### `query_iter` — streaming

For large corpora, `query_iter` yields `(metadata, df)` pairs in completion
order. Peak memory is bounded by `max_loaded_traces` (or `memory_budget_mb`
in cgroup mode) regardless of total trace count:

```python
for meta, df in btp.query_iter('select count(*) as n from slice'):
  process(meta, df)
```

### `query_to_parquet` — write per-trace parquet files

```python
out_dir = btp.query_to_parquet(
    'select ts, dur, name from slice', out_dir='/tmp/results')
# /tmp/results/000.parquet, 001.parquet, ...
```

### Polars

`query_polars` and `query_and_flatten_polars` mirror their pandas
counterparts and return Polars DataFrames.

```python
>>> btp.query_polars('select count(1) from slice')
[shape: (1, 1)
┌──────────┐
│ count(1) │
│ ---      │
│ i64      │
╞══════════╡
│  2092592 │
└──────────┘, ...]
```

## Memory budgeting

Loading every trace into RAM at once does not scale beyond ~1k traces.
BTP supports two complementary modes; they are off by default to preserve
v1 behaviour.

### Bounded LRU pool

```python
from perfetto.batch_trace_processor.api import (
    BatchTraceProcessor, BatchTraceProcessorConfig)

cfg = BatchTraceProcessorConfig(max_loaded_traces=8)
with BatchTraceProcessor(huge_list, cfg) as btp:
  for meta, df in btp.query_iter('...'):
    ...
```

At most 8 traces are resident at any time. Traces evicted on access are
re-spawned from their original file when next queried.

### cgroup v2 freezer (default, no swap needed)

The default mode when the host exposes cgroup v2 freezer (kernel ≥ 5.2,
no sudo). Each trace processor lives in its own nested cgroup under
the BTP's parent. On eviction in a bounded pool, the LRU's per-TP
cgroup is **frozen** via `cgroup.freeze` — every task in it is
suspended (SIGSTOP-equivalent but kernel-managed). State is preserved
bit-perfectly: parsed trace, SQLite tables, prepared statements all
survive. Reacquire is a single cgroup write — no respawn, no
re-parse.

```python
cfg = BatchTraceProcessorConfig(
    max_loaded_traces=8,
    memory_budget_mb=8192,
    freeze_on_evict=True,         # default
    cgroup_enabled=True,          # default
)
```

`btp.info()['pool_mode']` reports `'freeze'`. The pool tracks
`freeze_evictions` and per-handle `freeze_count` for observability.

### cgroup v2 + swap (kernel-managed paging, opt-in)

When you explicitly want kernel-managed paging — e.g. on a host with
zram and you'd rather thrash zram than re-parse on eviction — set
`cgroup_swap_max_mb` to a non-zero value. The default is **0** so we
don't blow up the system swap (it's a shared resource).

```python
cfg = BatchTraceProcessorConfig(
    memory_budget_mb=8192,
    cgroup_swap_max_mb=4096,      # opt-in; default is 0 (no system swap)
    per_trace_rlimit_as_mb=2048,  # optional: hard kernel cap per shell
)
```

| Knob | Maps to | Effect |
|---|---|---|
| `memory_budget_mb` | `memory.high` | soft limit; kernel reclaims to swap above it |
| `cgroup_memory_max_mb` | `memory.max` | hard limit; offending TP gets OOM-killed (classified as `kind='oom_killed'`, never kills Python) |
| `cgroup_swap_max_mb` | `memory.swap.max` | cap on swap usage by this BTP — **defaults to 0** |
| `per_trace_rlimit_as_mb` | `setrlimit(RLIMIT_AS)` | per-shell VM ceiling; child dies cleanly with ENOMEM (`kind='rlimit'`) |

Auto-defaults pick `memory_budget_mb = 0.5 × MemAvailable` and
`query_workers = sched_getaffinity` when those config fields are `None`.

## Failure observability

Every per-trace failure is captured structurally rather than aborting the
whole run.

```python
btp.print_failures()      # one line each, human-readable
btp.failures()            # list of TraceFailure dataclasses
btp.failures_df()         # pandas DataFrame, metadata flattened to columns
```

Each failure has `kind ∈ {load_timeout, load_failed, oom_killed, rlimit,
tp_crash, query_timeout, query_error, unknown}`, plus `detail`,
`exit_code`, and a 4 KB `stderr_tail` where applicable. Filter as you
would any DataFrame:

```python
df = btp.failures_df()
df[df['kind'] == 'oom_killed']
df[df['device'] == 'pixel-7']
```

## Durable session cache

```python
cfg = BatchTraceProcessorConfig(session_dir='/tmp/my-session')
with BatchTraceProcessor(files, cfg) as btp:
  btp.query('select count(*) from slice')   # cold: spawns shells, fills cache
# kill -9 here is survivable.
with BatchTraceProcessor(files, cfg) as btp:
  btp.query('select count(*) from slice')   # warm: streams from SQLite
```

Backed by `session_dir/btp.sqlite` (stdlib `sqlite3` in WAL mode).
Cache key is
`sha256(sql ‖ ⨁(path, mtime))` — order-independent. Inspect / replay /
export:

```python
for q in btp.list_queries(): print(q.query_id, q.sql)
df = btp.replay(query_id)               # pandas DataFrame
btp.export(query_id, '/tmp/out.parquet')
```

On a 12-trace corpus we measure ≈ 100× speed-up on warm reruns of the
same query because the shells never have to be spawned.

## Watchdogs

| Hazard | Watchdog |
|---|---|
| Per-query exceeds `query_timeout_s` (default 15 min) | `Future.result(timeout=…)` inline — nothing to die |
| Trace processor crashes mid-query | `except (ConnectionError, OSError)` records `tp_crash` / `oom_killed` |
| Trace processor wedges (no crash, no progress) | Inline timeout closes the wedge before it starves the next query |
| Trace processor exceeds memory budget | Kernel OOM via `cgroup memory.max` |

`_assert_healthy()` is called at every query entry; if the executor was
shut down it refuses to dispatch rather than silently ignore the timeout.

## HTTP/JSON server (agents and UIs)

```python
url = btp.serve(port=8080)   # returns 'http://127.0.0.1:8080'
```

Endpoints (CORS on; stdlib `ThreadingHTTPServer`):

| Method + path | Returns |
|---|---|
| GET `/info` | instance metadata (trace count, mode, workers, etc.) |
| GET `/traces` | input traces with metadata |
| GET `/queries` | every query this session has seen |
| GET `/query/<qid>` | one query's metadata |
| GET `/results/<qid>` | rows; `?format=arrow` streams Apache Arrow IPC |
| GET `/progress` | live progress snapshot for the running query |
| GET `/failures` | structured failure log |
| GET `/config` | current config (saveable) |
| POST `/run` | `{sql}` → runs synchronously, returns `query_id` |
| POST `/cancel` | cancels in-flight work |
| POST `/config` | merge partial config |
| POST `/shutdown` | stop the server thread |

## Agentic flow

The same surface drives chained analysis from a script:

```python
qid = btp.run_query("select tid from thread where name = 'RenderThread'")
df = btp.replay(qid)
follow_up = ' UNION ALL '.join(
    f"select '{tid}' as tid, count(*) as n from slice where utid = "
    f"(select utid from thread where tid = {int(tid)})"
    for tid in df['tid'].unique())
btp.run_query(follow_up)
```

`run_query` always writes to the durable cache; subsequent `replay` calls
are zero-RTT.

## Trace URIs

(Unchanged from v1 — full description preserved for backwards compat.)

URIs decouple "paths" to traces from the filesystem. Instead, the URI
describes *how* a trace should be fetched (HTTP, GCS, etc.).

```
Trace URI = protocol:key1=val1(;keyn=valn)*
```

Example:

```
gcs:bucket=foo;path=bar
```

The `gcs` resolver is illustrative; actual ones must be implemented and
registered as Python classes — see the
[TraceUriResolver class](https://cs.android.com/android/platform/superproject/main/+/main:external/perfetto/python/perfetto/trace_uri_resolver/resolver.py;l=56?q=resolver.py).

## ulimit and resource configuration

BTP nudges via the logger if `RLIMIT_NOFILE` or `RLIMIT_NPROC` look tight
for the trace count (no auto-bump — you may be in a hardened
environment). It does not require sudo for any of the cgroup work — user
delegation under `user.slice` is sufficient on every modern systemd
distro.

`tools/btp_bench.py` reproduces the comparisons that motivated v2's
design:

```shell
SHELL_PATH=$PWD/out/linux/trace_processor_shell \
python3 python/tools/btp_bench.py --copies 30 --max-loaded 4
```

Expect `qps ≈ 350–400` concurrent on a modern host with the unbounded
mode, and ≈ 100× speed-up on warm reruns once the durable cache is
populated.

## Sharing computations between TP and BTP

`execute` and `execute_and_flatten` accept any callable that takes a
`TraceProcessor` and returns whatever you want. They mirror `query` /
`query_and_flatten`:

```python
def some_complex_calculation(tp):
  res = tp.query('...').as_pandas_dataframe()
  # ... do some calculations with res
  return res

# Single trace:
tp = TraceProcessor('/foo/bar.pftrace')
some_complex_calculation(tp)

# Many traces:
btp = BatchTraceProcessor(['...', '...', '...'])
[a, b, c] = btp.execute(some_complex_calculation)
flattened_res = btp.execute_and_flatten(some_complex_calculation)
```

## Bigtrace UI integration

The Bigtrace UI ships with a **BTP** page (`/btp` route) that
consumes the same HTTP endpoints. Click *BTP (Python)* in the
sidebar, paste your `btp.serve(...)` URL, and you get:

- a connection panel (host:port + connect/disconnect),
- a metadata-flattened table of every input trace,
- a SQL editor + run button,
- a live progress bar that polls `/progress` every 1.5 s while a
  query is running,
- a queries-history pane (click a row to load its results),
- a results pane (first 200 rows, all columns),
- a structured failures pane.

The page makes no assumptions about the BTP host: anything that
serves the v2 HTTP contract works.

## Where to read more

- Internal design + change-log: [BatchTraceProcessor v2 design](/docs/design/btp-rework.md)
- Original v2 plan with the 38 captured requirements: [btp-v2-plan.md](/docs/design/btp-v2-plan.md)
- Single-trace API: [Trace Processor (Python)](/docs/analysis/trace-processor-python.md)
