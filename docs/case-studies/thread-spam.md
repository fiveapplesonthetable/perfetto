# Short-lived thread spam

`new Thread { … }.start()` per request looks innocuous in code.
In a trace it's a forest of one-shot threads, each created,
running for milliseconds, then dying — and ART pays JIT/init
costs every time.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.

## Capture

```
ftrace_events: "task/task_newtask"
ftrace_events: "task/task_rename"
ftrace_events: "sched/sched_switch"
atrace_categories: "sched"
atrace_apps: "com.example.perfetto.threadspam"
```

`task/task_newtask` is the kernel-side thread creation event.
Counting these per process tells you the spawn rate.

Full config:
[`trace-configs/threadspam.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/thread-spam/trace-configs/threadspam.cfg).

## Case study: a `Thread` per dispatch

The Activity dispatches 200 short tasks. The buggy version
spawns a thread for each:

```java
new Thread(() -> {
    long deadline = System.nanoTime() + 10_000_000;
    while (System.nanoTime() < deadline) { /* simulated work */ }
}, "Net-" + n).start();
```

200 threads, each running for ~10 ms then exiting.

### Find it

```sql
SELECT 'distinct threads in proc:'||COUNT(DISTINCT name)
FROM thread
WHERE upid = (SELECT upid FROM process WHERE name='com.example.perfetto.threadspam');
```

Before-trace: **232 distinct threads in the process** (200
spawned + framework + runtime). In the UI the process expands to
show a wall of one-shot thread tracks; each track has a single
~10 ms `Running` slice and then disappears.

### Fix

Use a fixed-size thread pool. Submit work; the pool reuses the
threads:

```java
private final ExecutorService net = Executors.newFixedThreadPool(4, r -> {
    Thread t = new Thread(r, "Net");
    t.setDaemon(true);
    return t;
});

// at the call site:
net.submit(() -> { /* work */ });
```

For Kotlin: `Dispatchers.IO` (which is itself a thread pool)
gives you the same behaviour.

### Verify

After-trace: **34 distinct threads** (4 pool workers + framework
+ runtime). 7× fewer threads to schedule, no ART thread-init
cost on the hot path. Average dispatch slice drops from 0.37 ms
to 0.16 ms (the difference is the cost of `new Thread().start()`
itself).

## Second pattern: per-request `OkHttpClient`

Constructing an `OkHttpClient` per request includes its own
internal dispatcher thread pool. A trace from such an app shows
the same pattern — bursts of short-lived `OkHttp …` worker
threads on every network call. Fix: a singleton `OkHttpClient`
shared app-wide.

## See also

- [Lock contention](lock-contention.md) — when the bottleneck is
  inside the pool, not in spawning.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/thread-spam>
