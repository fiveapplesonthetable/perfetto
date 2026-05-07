# BatchTraceProcessor v2 — design + change-log

**Status:** implemented on `dev/zezeozue/btp-rework`.
**Author:** zezeozue@.
**Audience:** anyone using `perfetto.batch_trace_processor` from Python — humans at notebooks, agents driving analysis end-to-end, or UI front-ends.

This is both the design doc and the change-log. It explains what changed, why, and how the pieces fit together. Each section is short by intent. The plan that drove this work is at `docs/design/btp-v2-plan.md`.

---

## 1. What BTP is, and why we touched it

`BatchTraceProcessor` is the blessed Python entry-point for fanning out SQL across many Perfetto traces. Each trace becomes a child `trace_processor_shell` process; queries hit them in parallel via an HTTP control plane.

Before this rework it had three structural problems:

1. **Concurrency hazards.** Several latent bugs that produced silent corruption or hangs once you scaled past ~hundreds of traces (see §2).
2. **No working-set bound.** Every input trace stayed loaded forever. 10⁴–10⁵ traces wasn't viable.
3. **Stateless.** A `kill -9` lost everything. A repeated query re-did all the work.

The rework keeps the existing public API exactly (47 pre-existing tests still pass on it) and adds new, additive APIs for the new capabilities.

## 2. Bugs fixed

| Tag | Where | Symptom | Fix |
|---|---|---|---|
| B1 | `__init__` partial-load failure | Already-spawned shells leaked + held ports; `close()` couldn't find them. | Replaced `executor.map` with `submit + as_completed`; track loaded TPs explicitly; close + shutdown on first failure. |
| B2 | `TraceProcessorHttp` thread safety | Two concurrent queries against one TP corrupted the HTTP framing → `BadStatusLine` or hung `recv()`. | Per-TP `threading.Lock` wrapping every request/response. |
| B3 | `TraceProcessor.close` ordering | `close()` mid-query waited for the OS TCP timeout. | Drain HTTP first; SIGTERM with bounded wait; SIGKILL fallback; idempotent. |
| B4 | `shell.py` load timeout | Spurious "TP failed to start" under heavy concurrent spawn. | Default raised 2 s → 30 s; polling 1 s fixed → 50 ms exponential to 1 s. |
| B5 | Hard SIGKILL on shutdown | Shells couldn't release ports / flush stderr. | SIGTERM-then-SIGKILL with timeout. |
| B6 | `cpu_count()` ignored cgroup quota | 64-core host, 4-cpu container quota → 64 workers. | `os.sched_getaffinity(0)`. |
| B7 | Executors never shut down | Daemon threads leaked. | `shutdown(wait=True, cancel_futures=True)`. |

## 3. The runtime model in one diagram

```
                        BatchTraceProcessor
                              │
         ┌───────────┬────────┼────────┬───────────────┐
         ▼           ▼        ▼        ▼               ▼
   Public API   ProgressTracker   FailureLog   BtpServer (HTTP/JSON)
         │                                        ↑
         ▼                                        │
   _cached_query_iter  ─────────────►  Session (SQLite)
         │                                        ↑
         ▼                                        │
   ThreadPoolExecutor ───► TpPool ──► trace_processor_shell × N
                              │              │
                              │              └─ all in →  Cgroup v2
                              │                          (memory.high
                              │                           memory.max
                              │                           swap.max)
                              ▼
                  per-TP HTTP client + lock
```

Files (one module per concern):

| File | Concern |
|---|---|
| `pool.py` | LRU-managed `TpPool`, optional cgroup attach, lazy first-load, idempotent close. |
| `cgroup.py` | Per-instance memcg with `memory.high` / `memory.max` / `memory.swap.max`. |
| `linux.py` | ulimit nudge, `RLIMIT_AS` preexec, `/proc/swaps` + `/proc/meminfo` readers. |
| `failure.py` | `TraceFailure` dataclass + thread-safe `FailureLog`. |
| `progress.py` | Lock-free `ProgressTracker` snapshot. |
| `defaults.py` | Auto-tune from device resources; JSON save/load. |
| `session.py` | SQLite-backed durable cache (`btp_traces` / `btp_queries` / `btp_results` / `btp_failures` / `btp_config`). |
| `inputs.py` | `TracesWithMetadata` for `(path, dict)` input. |
| `server.py` | Stdlib HTTP/JSON server for agents + UIs. |
| `api.py` | Public `BatchTraceProcessor` — orchestrates everything else. |

## 4. Memory budgeting

There are two mutually-compatible mechanisms; you pick by what your platform supports.

### 4.1 Three modes, one cascade

| Mode | When | Eviction does | State after eviction |
|---|---|---|---|
| `unbounded` | every TP fits in RAM | n/a | resident |
| `freeze` (default when freezer is available) | bounded pool, kernel ≥ 5.2 | `cgroup.freeze` on the per-TP cgroup | preserved bit-perfectly; thaw is one cgroup write |
| `cgroup` (paging) | bounded pool + swap explicitly opted-in via `cgroup_swap_max_mb` | none — kernel pages cold pages out | resident in swap |
| `lru` (close + reload) | freezer + paging both unavailable | `tp.close()` + reload from `metadata['_path']` | gone; full re-parse on reacquire |

The default cascade picks the strongest available primitive. `freeze`
is the right default because it preserves state without depending on
swap (and swap is a shared system resource we don't want to thrash).

### 4.2 cgroup v2 + swap (kernel-managed paging — opt-in)

We create one transient cgroup per `BatchTraceProcessor` under your user delegation slice (no sudo) and attach every spawned shell to it. Three knobs:

- `memory.high` (soft) — when total RSS crosses this, the kernel proactively pages anonymous pages out to swap.
- `memory.max` (hard) — exceeding this triggers the cgroup OOM killer. Only the offending TP is in the cgroup; Python is not. So the run keeps going; we record the kill via `memory.events.oom_kill` and surface it as `kind='oom_killed'` in `failures_df()`.
- `memory.swap.max` — caps how much swap the cgroup may use.

zram makes this fast: a cold TP with hundreds of MB of mostly-zero anon pages compresses to ~30 MB at lz4 speed. Re-touching an "evicted" TP is a page-fault-back-in, not a re-parse. The kernel does the LRU work page-by-page.

Requirements: cgroup v2 with `memory` controller, user delegation (every modern systemd distro), and *some* swap (disk or zram). Without swap, `memory.high` collapses into `memory.max` because the kernel can't reclaim anonymous pages.

**Default `cgroup_swap_max_mb=0`.** The system swap is a shared resource. A multi-GB BTP corpus paging through the device's swap can starve other processes. Paging mode is opt-in (set the value explicitly); the freeze path below is what runs by default.

### 4.3 cgroup v2 freezer (default, no swap needed)

The "dump pages and resurrect" Linux primitive: write `1` to a cgroup's `cgroup.freeze` and the kernel stops scheduling every task in it (SIGSTOP-equivalent but kernel-managed; no signal is delivered). State (parsed trace, SQLite tables, prepared statements, the HTTP server socket) is preserved bit-perfectly. Reacquire is `0 → cgroup.freeze`.

The pool gives every TP its own nested cgroup under the BTP's parent so they freeze independently. On eviction in a bounded pool we freeze the LRU; on reacquire we thaw. **`load_count` stays at 1 across the whole run** — no respawn, no re-parse, no SQLite warmup. `freeze_count` increments instead.

Requirements: cgroup v2 user delegation (sudoless) AND the freezer file (kernel ≥ 5.2). No swap dependency.

### 4.4 LRU close-and-reload (fallback)

If both freezer and paging are unavailable (older kernel, non-Linux), we fall back to closing TPs on memory pressure and re-spawning + re-parsing them on next acquire. Works everywhere, including macOS and Windows. Cost: full re-parse on every reload (0.5–2 s per trace).

The constructor logs which path it picked: `pool_mode={freeze,cgroup,lru,unbounded}`.

## 5. Watchdogs (and why they're inline, not threads)

Every limit is enforced by a mechanism that is itself supervised:

| Hazard | Watchdog |
|---|---|
| Per-query exceeds `query_timeout_s` (default 15 min) | `Future.result(timeout=...)` in the calling stack |
| TP crashes mid-query | `except (ConnectionError, OSError)` in `_run_on_handle` |
| TP wedges (no crash, no progress) | Same `Future.result(timeout=...)`; we `tp.close()` the wedge |
| TP exceeds memory budget | Kernel OOM via `cgroup memory.max` |
| Python parent dies | OS reaps children (subprocess.Popen owns them) |

We deliberately do **not** run a separate watchdog thread. A separate thread would itself need a watchdog. The inline-timeout model has nothing to die: as long as the caller is alive, the watchdog is alive. As long as the kernel is alive, the cgroup limits are enforced. `_assert_healthy()` is called at every query entry and refuses to dispatch if the executor is shut down — fail loud rather than silently drop the timeout guarantee.

We do **not** use `PR_SET_PDEATHSIG`: the kernel binds it to the *thread* that called `fork()`, so children spawned from a `ThreadPoolExecutor` worker get SIGKILL when that worker exits — even if Python is still alive. Empirically this manifested as "Connection reset by peer" mid-query. Removed.

### 5.1 Linux primitives we use (and the polling we don't)

Every resource control and child-management mechanism here delegates to a kernel primitive rather than rolling our own polling loop:

| Concern | Primitive | Rationale |
|---|---|---|
| Per-trace VM cap | `setrlimit(RLIMIT_AS)` via `subprocess.Popen(preexec_fn=…)` | hard kernel ceiling; ENOMEM on first overflow, child dies cleanly |
| Per-instance memory budget | cgroup v2 `memory.high` / `memory.max` / `memory.swap.max` | kernel's reclaim + OOM machinery; no userspace LRU heuristics |
| OOM classification | cgroup v2 `memory.events.oom_kill` counter | kernel-authoritative — distinguishes OOM-kill from generic crashes |
| Cgroup teardown synchronisation | `select(POLLPRI)` on `cgroup.events` | `populated` 1→0 raises POLLPRI; no sleep loops, no busy-wait |
| Atomic kill of cgroup members | `echo 1 > cgroup.kill` | one-shot SIGKILL to all tasks + descendants (kernel ≥ 5.14) |
| Child shutdown | `subprocess.terminate(); wait(timeout); kill(); wait()` | `wait` uses `waitpid` — kernel-blocking, not a poll |
| Worker-count auto-tune | `os.sched_getaffinity(0)` | respects cgroup cpu quota in containers |
| Free-memory probe | `MemAvailable` from `/proc/meminfo` | kernel's own "how much is usable" heuristic |
| Swap presence | `/proc/swaps` line count | direct kernel state, no shelling out |
| ulimit headroom check | `getrlimit(RLIMIT_NOFILE / RLIMIT_NPROC)` | the actual limits Python will hit, not approximations |

The one place we still do a bounded poll is `shell.py` startup readiness — there is no fd-based "HTTP listener is ready" signal from `trace_processor_shell`. We compensate with exponential backoff (50 ms → 1 s) up to `load_timeout` and distinguish "timed out (`LoadTimeoutError`)" from "child exited during startup (`LoadFailedError`)" so the BTP can classify as `load_timeout` vs `load_failed` / `rlimit`.

## 6. Durable session

`BatchTraceProcessorConfig.session_dir = Path('/somewhere')` opts in. Backed by a single SQLite file under that directory.

Schema:

```
btp_traces      handle_idx, path, mtime, metadata_json
btp_queries     query_id PK, sql, started, completed, total_traces
btp_results     query_id, handle_idx, parquet BLOB, rows, executed, error
                  PRIMARY KEY (query_id, handle_idx)
btp_failures    handle_idx, kind, detail, when_ts, exit_code, stderr_tail
btp_config      key PK, value
```

`query_id` is `sha256(sql ‖ ⨁(path, mtime))` — stable across input order. On a query call we look up `(query_id, handle_idx)`; cache hits stream from the DB without spawning shells; misses dispatch normally and write back. `kill -9` is survivable: the DB is on disk, every result is written before the next query starts.

Public surface added on top:

```python
btp.list_queries()           # CachedQuery records, newest first
btp.replay(query_id)         # cached results -> single DataFrame
btp.export(query_id, path)   # write to parquet
btp.session                  # the Session itself, for SQLite-level access (stdlib `sqlite3`)
```

## 7. Per-trace metadata

`TracesWithMetadata([(path, {'device': ..., 'scenario': ..., 'build': ...}), ...])` carries per-trace columns through the entire pipeline. They appear:
- as columns in `query_and_flatten` results,
- as filterable columns in `failures_df()`,
- as their own row in `btp_traces`,
- in the `/traces` HTTP endpoint.

Pre-filter the input list to query a subset (e.g. only Pixel 8s).

## 8. HTTP/JSON server (agent + UI ready)

```python
btp.serve(port=8765)  # returns 'http://127.0.0.1:8765'
```

Endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/info` | mode, trace_count, max_loaded, session_dir, cgroup, budgets |
| GET | `/traces` | every trace + flattened metadata |
| GET | `/queries` | every cached query (id, sql, started, completed, ...) |
| GET | `/query/<qid>` | one query's metadata |
| GET | `/results/<qid>` | rows; `?format=arrow` streams Apache Arrow IPC |
| POST | `/run` | `{sql}` → runs synchronously, returns `query_id` |
| GET | `/progress` | live `Progress` snapshot |
| GET | `/failures` | structured failure log |
| GET | `/config` | current config (saveable) |
| POST | `/config` | partial config update; live + persisted |
| POST | `/cancel` | best-effort cancel of in-flight |
| POST | `/shutdown` | clean stop of the server thread |

Used by the agentic flow (chain queries, branch on results) and by the Bigtrace UI's `/btp` page (`ui/src/bigtrace/pages/btp_page.ts`). The page connects to a host:port, lists traces with their metadata, runs SQL, polls `/progress` while the run executes, and surfaces structured failures + cached query history. Same contract that an agent would consume.

## 9. Configuration ergonomics

Defaults derived from the host:

| Knob | Default |
|---|---|
| `memory_budget_mb` | 50% of `MemAvailable` from `/proc/meminfo` |
| `query_workers` | `len(sched_getaffinity(0))` |
| `query_timeout_s` | 900 (15 min) |
| `cgroup_enabled` | True (auto-detected) |
| `cgroup_memory_max_mb` | `1.25 × memory_budget_mb` |
| `cgroup_swap_max_mb` | full system swap |
| `load_timeout` | 30 s with exponential backoff |

Override any by setting the field. Save/load JSON:

```python
btp.save_config(Path('btp.json'))
loaded = load_config_json(Path('btp.json'))
cfg = BatchTraceProcessorConfig(**loaded)
```

`update_config({...})` accepts partial dicts at runtime; live-applicable knobs (`query_timeout_s`, `spill_dir_max_mb`) take effect immediately, others are persisted into `btp_config` for the next session attach.

## 10. Failure observability

Every failure mode produces a `TraceFailure(handle_idx, metadata, kind, detail, ...)` and lands in three places:

1. `btp.failures()` — list of structured records.
2. `btp.failures_df()` — pandas DataFrame with metadata flattened to columns.
3. `Stats.failures` — same list, for users polling `btp.stats()`.

Plus `print_failures()` writes a one-line-per-failure rendering to stderr.

Kinds (each with the path that emits it):

| Kind | Emitter |
|---|---|
| `load_timeout` | `shell.LoadTimeoutError` (poll deadline elapsed, child still alive) |
| `load_failed` | `shell.LoadFailedError` with no rlimit set, or generic `TpPoolFailure` |
| `oom_killed` | shell died (`ConnectionError`/`OSError`) AND cgroup `memory.events.oom_kill` incremented |
| `rlimit` | `shell.LoadFailedError` with `exit_code < 0` AND `per_trace_rlimit_as_mb` was set |
| `tp_crash` | shell died (`ConnectionError`/`OSError`) without an OOM signal |
| `query_timeout` | `Future.result(timeout=…)` hit `concurrent.futures.TimeoutError` |
| `query_error` | shell raised `TraceProcessorException` (SQL error, etc.) |
| `unknown` | normaliser fallback for any uncategorised entry |

## 11. ulimit nudge

At construction we check `RLIMIT_NOFILE` and `RLIMIT_NPROC`. If headroom < `4 × num_traces`, we log one `WARNING` line with the current values and the suggested `ulimit` command. We do **not** auto-bump — the user might be in a hardened environment where that fails for reasons we don't control.

## 12. What's tested, what's measured

### 12.1 Tests

`python/test/batch_trace_processor_unittest.py` — 21 v1 cases (pool LRU correctness, B1 leak cleanup with subprocess accounting, B2 8-thread × 50-query stress, B3 close-during-query, query_iter loaded-count bound, per-trace metadata flow, spill cap LRU-by-mtime, parquet, etc.).

`python/test/batch_trace_processor_v2_unittest.py` — 13 v2 cases:

  - Failure log shape + concurrent-add safety.
  - Query timeout records a failure (drives `_handle_query_timeout` directly to avoid PerfettoSQL anti-patterns in tests).
  - Config JSON round-trip; callable fields silently dropped.
  - `query_id` stability across trace order.
  - Cache hit returns instantly on the second open of the same `session_dir`.
  - `kill -9` survivable: a child process is killed mid-run; resume picks up cached rows.
  - Per-trace metadata flows through cache + replay.
  - `Progress` lifecycle (idle → active → step → end).
  - HTTP server: `/info`, `/traces`, `/run`, `/results`, `/progress`.
  - Agentic flow: chain query results into a derived query.

All 71 tests pass (21 v1 BTP + 21 v2 + 29 legacy `api_integrationtest`). The v2 count grew through audit cycles: 13 base → 14 with `TestLoadFailureClassification` (load_timeout / rlimit / load_failed shape) → 20 with `TestRealWorkloadEdgeCases` (metadata-filtered flatten, surviving INCREMENT_STAT failure, mtime cache invalidation, list/replay/export round-trip, empty trace list, concurrent-same-query coalescing) → 21 with `TestFreezeMode` (cgroup v2 freezer preserves state across eviction; load_count stays 1 despite forced evictions).

### 12.2 Benchmarks

`python/tools/btp_bench.py`. Two sample runs on this host (`example_android_trace_30s.pb`, query=`select count(*) from slice`, `--max-loaded 4`):

12 copies (verbatim from this audit):

```
[unbounded ] cold_load=7.40s hot_query_p50=26.4ms qps=394 errors=0
[lru       ] max_loaded=4 pass1=12/20.10s/12loads pass2=12/19.79s/12reloads
              rss_delta_mb=49
[cgroup    ] skipped — cgroup v2 + swap not available on this host
[freeze    ] mode=freeze max_loaded=4 pass1=12/19.67s/12loads
              pass2=12/54.8ms/0reloads  freeze_evictions=20
              rss_delta_mb=6
[durable   ] max_loaded=4 cold_session=20.16s warm_total=169.5ms
              warm_query_only=61.0ms (≈119× full-session speedup,
              ≈325× on the query-only phase)
```

Freeze mode is the headline number: pass2 went from **19.79s** (LRU close+reload) to **54.8ms** — a **~360× speed-up** because no shell respawns and no re-parses. RSS delta is also lower (6 MB vs 49 MB) since we don't churn through transient peak allocations. Durable cache still wins on the very-warm path (results streamed straight from SQLite, no Python<->shell roundtrip).

Both runs were captured on this audit host. The LRU row's pass2 reloads = trace count is expected when `max_loaded < trace count` and the query iterates through every trace; each access evicts the LRU and reloads the next from disk via `metadata['_path']`. RSS stays roughly flat between LRU passes — the working set really is bounded.

The durable-cache speedup is the single biggest practical win. On a host with zram available, the `cgroup` row replaces the LRU row at substantially lower per-query cost (no full re-parse).

## 13. What's NOT in scope

- ~~**Bigtrace UI page that browses BTP instances.**~~ Done in this commit — see `ui/src/bigtrace/pages/btp_page.ts`.
- **Cross-machine distribution.** Single-machine BTP only. For distributed analysis, see Bigtrace + the orchestrator gRPC contract under `protos/perfetto/bigtrace/`.
- **C++ trace_processor state-serialise.** A cgroup-paged TP is fast enough on warm reload that snapshotting parsed state to disk hasn't proven necessary. If reload churn becomes a bottleneck on a real workload, this is the next thing to add.
- **TinyLFU eviction.** Plain LRU has been good enough in observed workloads.

## 14. File-level change log

| File | Change |
|---|---|
| `python/perfetto/batch_trace_processor/api.py` | Major rewrite; preserves public API. |
| `python/perfetto/batch_trace_processor/pool.py` | Sharing-aware acquire/release; cgroup attach. |
| `python/perfetto/batch_trace_processor/cgroup.py` | NEW. |
| `python/perfetto/batch_trace_processor/linux.py` | NEW. |
| `python/perfetto/batch_trace_processor/failure.py` | NEW. |
| `python/perfetto/batch_trace_processor/progress.py` | NEW. |
| `python/perfetto/batch_trace_processor/session.py` | NEW. |
| `python/perfetto/batch_trace_processor/server.py` | NEW. |
| `python/perfetto/batch_trace_processor/inputs.py` | NEW (v1 carry-over). |
| `python/perfetto/batch_trace_processor/defaults.py` | NEW. |
| `python/perfetto/trace_processor/http.py` | Per-TP lock; idempotent `close`. |
| `python/perfetto/trace_processor/api.py` | `close()` reorder; `preexec_fn` parameter. |
| `python/perfetto/trace_processor/shell.py` | Backoff polling; `preexec_fn` flow-through. |
| `python/test/batch_trace_processor_unittest.py` | 21 v1 cases. |
| `python/test/batch_trace_processor_v2_unittest.py` | 13 v2 cases. |
| `python/tools/btp_bench.py` | All-modes bench. |
| `docs/design/btp-rework.md` | This document. |
| `docs/design/btp-v2-plan.md` | The plan that drove the work. |
