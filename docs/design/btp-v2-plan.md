# BatchTraceProcessor v2 — full scope plan

This document captures every requirement collected across the rework
discussion so it survives context compaction. No code yet; this is the
plan + scope-honesty before implementing.

## Requirements (verbatim, deduped)

### From the original ask

1. Fix bugs that cause deadlocks / hangs.
2. Manage resources: feed it 10s of thousands of traces, specify how
   much memory to use, accept queries seamlessly. Worst case load
   from disk (already-serialised), best case in memory. Persist
   intermediate results to disk when more traces than memory budget.
3. Robust, modern, clean. Don't break consumers.

### From "ensure no bugs and high performance"

4. Comprehensive bench in detail. Test all ways. Ensure no bugs and
   high performance.

### From "metadata for trace address"

5. Per-trace metadata as multiple columns (device, scenario, build,
   …). User filters to specific subsets.

### From "LRU as we get more traces so we fit within memory budget"

6. LRU eviction tied to memory budget — explicit confirmation.

### From "let's simplify"

7. Simple default behaviour. (Already done for the heap-dump
   redirect; principle applies here too.)

### From the deeper-redesign turn

8. Proper recovery from disk: don't re-parse. Pull state back into
   memory. Linux concepts (swap, cgroup) preferred over reinventing.
9. Per-BTP-instance cache size, robust, low lock contention. Locks
   never held for long operations. Python locks must not block us.
10. No runaway processes: load timeout, max in-memory size, skip
    such traces. TP crash never takes down the run. Robust error
    reporting so the user understands what failed.
11. Smart Linux concepts (swap, cgroup, no sudo) for elegant design.

### From "kill on exceeding fine, log it, command to inspect"

12. Default query timeout 15 min. Override per-call.
13. Killed-trace details available via a command (`failures()`,
    `failures_df()`, `print_failures()`).
14. Single-machine. Stay within ulimits; nudge user to bump if tight.

### From "per-trace memory limits, throttle then kill"

15. Per-trace **soft limit** triggers swap. Per-trace **hard limit**
    triggers OOM-kill. Excessively big traces don't slow others; we
    handle "fairly big" via throttling.

### From "easy to configure, save, inspect"

16. Sensible defaults derived from device resources. Overridable.
    Saveable + reloadable.
17. Stats easy to see; progress easy to inspect; reports.

### From the durability ask (voice)

18. Crash recovery: `kill -9` on the BTP process must be survivable
    on next launch. Excel-heal-style.
19. Results stored in a **SQLite instance** at the session root.
    Every query writes a row in a results table. Nothing ever lost.
20. Replay across runs: list past queries, fetch cached results,
    rerun selectively.
21. Plugin point for "stream results to a remote server" — design
    the API but ship local-only first.
22. If a query already ran on the same `(sql, traces, trace mtimes)`,
    return from cache instantly.
23. "If I notice an issue and run again, queries should resume as if
    never left memory." → cache is durable, not just in-RAM.

### From the Bigtrace-UI ask (voice)

24. `ui/src/bigtrace/` lets users pick a BTP instance from settings.
    See multiple instances on different ports.
25. Once selected, the UI shows: all sessions, all trace metadata,
    every saved query. User can configure params from the UI.
26. BTP exposes APIs the Bigtrace UI calls: get-metadata,
    get-execution-configs, save-them. Persistent across BTP restarts.
27. E2E test the UI too — xvfb, screenshots, verify it actually works
    end-to-end. Cancel/start/kill, measure memory.

### From the meta-guidance

28. L7 SWE Google quality. No hacks. Take time.
29. **One squashed commit** at the end.
30. Iterate: plan → review → look at code → implement, "at least 5
    times".
31. Save plans persistently (this document).
32. **No over-engineering.** ← important counter-pressure.
33. Document well: design + change log; clean prose, explain the
    why; no AI-speak fluff.
34. Don't leave anything behind. No "follow-up" promises.

## Honest scope assessment

Items 1–17 (the original BTP rework + memory budgeting + per-trace
limits) form a coherent, ~2-day chunk. Mostly already done:
- Pre-existing v1 commit `1cdeb22a25` covers 1, 2, 3, 5, 6, 7, parts
  of 4, parts of 9, parts of 10, partly 14.
- Failure log + ulimit nudge + linux helpers (`failure.py`,
  `linux.py`) drafted in the WIP — needs a clean re-application.

Items 18–23 (durable session, SQLite cache, replay) are a separate
~2-day chunk. They genuinely change BTP's identity from "stateless
query fan-out" to "lab notebook." Not over-engineering — directly
addresses the user's voice-stated need ("nothing ever lost" + "as if
it never left memory").

Items 24–27 (Bigtrace UI integration + e2e) are another ~2–3 days.
Bigtrace today uses gRPC to talk to its orchestrator (see
`python/perfetto/bigtrace/api.py:25` — `BigtraceOrchestratorStub`).
Making BTP show up as a Bigtrace-selectable instance means either:
   (a) implementing the Bigtrace orchestrator gRPC contract on top
       of BTP, or
   (b) extending the Bigtrace UI to also know about a different
       (HTTP?) protocol BTP exposes.
Either is non-trivial. (a) means turning BTP into a process that
serves gRPC; (b) means UI work + a new BTP HTTP API.

Items 15 (per-trace soft+hard limits) and 11 (cgroup+swap path) are
deeply intertwined; one cgroup config gives you both.

Realistic total: **5–7 days of focused work** for the full set
end-to-end with proper tests, profiling, and the design+changelog
docs requested.

## Proposed phasing (MVP-first, no over-engineering)

Each phase is independently shippable and the next is gated on the
previous landing green.

### Phase A — Robust v2 core (3 days)

In scope:
- Failure log (already drafted), wired through every error path.
- Per-load + per-query watchdogs. Default `query_timeout_s=900`.
- Per-trace `RLIMIT_AS` + `PR_SET_PDEATHSIG` (already drafted).
- cgroup v2 + swap path: detect support, create per-BTP memcg with
  `memory.high` (soft) and `memory.max` (hard), set `swap.max`,
  attach TPs at fork. **Single per-BTP cgroup**, not per-trace, in
  this phase. Per-trace caps via `RLIMIT_AS`.
- Sharded LRU + background close-reaper.
- ulimit nudge.
- `BatchTraceProcessor.failures() / failures_df() / print_failures()`.
- Auto-tuned defaults (memory_budget_mb derived from system MemAvail
  if user doesn't set it).
- `BatchTraceProcessorConfig.save(path)` / `load(path)` — JSON.
- Tests: 30-trace stress with chaos kill mid-query, OOM injection
  via `memory.max=1MB` on a single TP, ulimit warning, RLIMIT_AS
  trip, query timeout, save/load round-trip.
- Bench: cold load, hot p50, concurrent throughput, bounded passes,
  reload-from-swap vs reload-from-disk.

Out of scope this phase: durable cache, Bigtrace UI.

### Phase B — Durable session + replay (2 days)

In scope:
- `Session` object in `python/perfetto/batch_trace_processor/session.py`.
  Backed by SQLite at `session_dir/btp.sqlite`.
- Schema:
  ```
  traces      (handle_idx, path, mtime, metadata_json)
  queries     (query_id, sql, started, completed, total_traces)
  results     (query_id, handle_idx, parquet_blob, executed, error)
  failures    (handle_idx, kind, detail, when, exit_code, stderr_tail)
  config      (key, value)  -- saved BatchTraceProcessorConfig
  ```
- `query()` / `query_iter()` first hash `(sql, sorted-traces-paths,
  sorted-traces-mtimes)` → `query_id`. If `(query_id, every
  handle_idx)` row already present, instant return from SQLite.
  Otherwise execute the missing ones, write to SQLite.
- Constructor with same `session_dir` resumes:
  - Reattach SQLite.
  - Show resumed counts in `Stats` (already-cached queries, partial
    queries, failed handles to retry).
- `BatchTraceProcessor.list_queries()`,
  `BatchTraceProcessor.replay(query_id) -> DataFrame`,
  `BatchTraceProcessor.export(query_id, path)`.
- Crash test: `kill -9` mid-query, restart with same `session_dir`,
  assert state reconstructed correctly.

### Phase C — Bigtrace UI integration (2–3 days)

In scope:
- BTP exposes a small HTTP API on a configurable port (`btp.serve(
  port=...)`):
  - `GET  /info`           → instance metadata.
  - `GET  /sessions`       → list sessions in the dir.
  - `GET  /traces`         → list traces with metadata.
  - `GET  /queries`        → list past queries.
  - `POST /query`          → run a query, stream Arrow IPC.
  - `GET  /config`         → current config.
  - `POST /config`         → update config.
  - `POST /cancel`         → cancel an in-flight query.
- `ui/src/bigtrace/settings/instances.ts`: list of `host:port`
  endpoints, persisted to localStorage.
- New entry point in the Bigtrace UI page that lists sessions on the
  selected instance, lets the user run a query and see results
  inline (Arrow IPC → DataGrid).
- E2E: xvfb-driven Chrome loads the Bigtrace UI, adds a BTP instance,
  picks a session, runs a query, screenshots at each step.

### Phase D — Polish + docs (0.5 day)

- Design doc updated to reflect what was built.
- CHANGELOG entry with the why for each major decision.
- One squashed commit, push to fork, email summary.

## What to do today

I'm going to:
1. **Reset the WIP** to commit `1cdeb22a25` (last green; 50/50 tests
   pass; v1 features intact). Keep `failure.py` and `linux.py` as
   reusable building blocks but apply them cleanly.
2. **Implement Phase A** end-to-end with tests and bench.
3. **Get Phase A green** before moving to B.
4. **Stop and report progress** before starting Phase B/C so you can
   re-prioritise if the UI work isn't worth blocking on.

If you want me to just pile through A→B→C in one go without
checkpointing, say so and I'll keep going. Otherwise default is
"stop after A, report, ask for Phase B kickoff."

## Additions captured after the first save

35. **Agentic use case is co-equal with human use.** APIs must be
    callable by an agent end-to-end: read data, iterate, use the
    result of one query as input to the next. "Ways to see what's
    being done" — progress, current state, recent history. This
    biases us toward stable Python+JSON contracts and away from any
    UI-first shape.
36. **One squashed commit** so the change is easy to patch. (Already
    in the meta-guidance — re-emphasised.)
37. **Rebase on latest upstream** after `git fetch origin`.
38. **No over-engineering.** Counter-pressure to all of the above:
    just enough abstractions for an L7 SWE level deliverable.

## Additions captured during the audit cycle

39. **Freeze cold trace processors via `cgroup.freeze`** instead of
    closing them. The "dump pages and resurrect" Linux primitive
    you'd reach for: cgroup v2 freezer suspends every task in the
    cgroup (kernel-managed, no signal delivered). State (parsed
    trace, SQLite, prepared statements, HTTP server socket) is
    preserved bit-perfectly. Reacquire is a single cgroup write.
    Runs only on tasks we own (children we spawned), so no sudo.
40. **Don't blow up the system swap.** Default `cgroup_swap_max_mb`
    is 0 — the BTP cgroup uses RAM only by default. Kernel-managed
    paging is opt-in. Avoids the failure mode where a multi-GB
    corpus thrashes the device's shared swap and starves other
    processes.
41. **Fall back gracefully** on hosts without cgroup v2 / freezer:
    LRU close-and-reload still works on every Linux + macOS. The
    cgroup features layer additively, never required.
42. **Bigtrace UI page that consumes the BTP HTTP server.** A
    mithril page (`ui/src/bigtrace/pages/btp_page.ts`) that
    connects to a running `btp.serve(...)` instance and exposes
    the same surface as the agentic API: list traces, run SQL,
    inspect cached queries, watch live progress + failures.
43. **Update both design doc + user-facing analysis doc** with
    every iteration. The design doc is authoritative for the
    rationale; the analysis doc is what notebook users see.

## Living document

When the implementation deviates from this plan, this file gets
updated, not abandoned.
