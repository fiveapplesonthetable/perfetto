# Main-thread I/O

Synchronous file I/O on the UI thread blocks the thread in
uninterruptible sleep (`D` state) for as long as the kernel takes
to flush. On flash storage that's milliseconds; on a busy disk,
hundreds.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.

## Capture

```
ftrace_events: "sched/sched_switch"
ftrace_events: "sched/sched_blocked_reason"
ftrace_events: "f2fs/f2fs_sync_file_enter"
ftrace_events: "f2fs/f2fs_sync_file_exit"
ftrace_events: "ext4/ext4_sync_file_enter"
ftrace_events: "ext4/ext4_sync_file_exit"
atrace_categories: "view"  "sched"  "binder_driver"
atrace_apps: "com.example.perfetto.mainio"
```

Both `f2fs` and `ext4` enter/exit are listed because Android
devices use one or the other depending on the filesystem.

Full config:
[`trace-configs/mainio.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/main-thread-io/trace-configs/mainio.cfg).

## Case study: `SharedPreferences.commit()` in a callback

The user toggles a settings tile; the handler writes the change:

```java
prefs.edit().putBoolean("k" + n, n % 2 == 0).commit();
```

`commit()` is synchronous — it writes the prefs XML and `fsync`s
before returning. On the main thread.

### Find it

```sql
SELECT 'count:'||COUNT(*)||' avg_ms:'||(AVG(dur)/1e6)
FROM slice WHERE name LIKE 'toggle#%';
```

Before-trace: **39 toggles, 1.58 ms each**. In the UI, find the
main thread, look at any `toggle#N` slice — expand it and you see
a `f2fs_sync_file` slice underneath. The main thread is in `D`
state for the duration.

![Buggy trace zoomed onto `toggle#0`. The slice details show the main thread is mostly Uninterruptible Sleep — it's blocked on the f2fs flush triggered by SharedPreferences.commit().](../images/main-thread-io/before.png)

### Fix

`apply()` schedules the write on a background thread and returns
immediately:

```java
prefs.edit().putBoolean("k" + n, n % 2 == 0).apply();
```

For larger or schema-bearing writes, migrate to
[DataStore](https://developer.android.com/topic/libraries/architecture/datastore),
which is coroutine-first and never blocks the caller.

### Verify

After-trace: **39 toggles, 0.17 ms each — 9.2× faster.** The
main thread no longer enters `D` state inside the toggle slice;
the actual disk write happens later on the background thread that
SharedPreferences manages.

![Fixed trace zoomed onto `toggle#0`. Same UI thread bind, no Uninterruptible Sleep — the disk write is deferred to SharedPreferences' background writer.](../images/main-thread-io/after.png)

## Second pattern: synchronous Room query in `onCreate`

A Room DAO call without `Async` / coroutine wrapping does the
same thing — the main thread blocks on the disk read. Often shows
up on cold start: the database open + first query land inside
`bindApplication` and add several hundred milliseconds.

## See also

- [App startup](app-startup.md) — main-thread I/O on cold start
  is a startup-time bug as much as a jank bug.
- [Frame jank](frame-jank.md) — runtime-time main-thread I/O
  shows up as missed frames.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/main-thread-io>
