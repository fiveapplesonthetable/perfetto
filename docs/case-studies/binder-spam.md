# Binder spam

Every `IBinder` call costs one round trip to another process —
typically `system_server`. Doing it once is fine. Doing it once
per frame quietly turns into a per-frame multi-millisecond tax
that shows up as battery drain and frame jitter.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.

## Capture

```
ftrace_events: "binder/binder_transaction"
ftrace_events: "binder/binder_transaction_received"
atrace_categories: "binder_driver"  "view"  "sched"
atrace_apps: "com.example.perfetto.binderspam"
```

Full config:
[`trace-configs/binderspam.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/binder-spam/trace-configs/binderspam.cfg).

## Case study: ConnectivityManager in `onPreDraw`

An Activity needs to reflect the current network state in its UI.
The simplest implementation reads it on every frame:

```java
root.getViewTreeObserver().addOnPreDrawListener(() -> {
    Trace.beginSection("checkNetwork");
    try {
        NetworkInfo ni = cm.getActiveNetworkInfo();   // <-- binder call
        t.setText("net=" + (ni != null && ni.isConnected()));
    } finally { Trace.endSection(); }
    return true;
});
```

`getActiveNetworkInfo()` makes a binder call to `system_server`'s
`ConnectivityService`. Per frame.

### Read the trace top-down

The `BinderSpamDemo` process row, expanded, looks normal at first
glance: a steady cadence of `checkNetwork` slices on the main
thread once per frame. The smoking gun is on the *receiving*
side. Find the `system_server` process and expand its binder
thread tracks — there's a constant trickle of incoming
`ConnectivityService.getActiveNetworkInfo` transactions, each
caused by one of those `checkNetwork` slices in the app:

![BinderSpamDemo process with checkNetwork slices on the main thread. Every slice corresponds to a binder transaction visible on the system_server side.](../images/binder-spam/before-wide.png)

This is the shape every "per-frame system call" bug takes: a
regular pulse on the app's main thread, paired with a regular
pulse on the receiving system service. Once you've seen it,
you'll spot it immediately on real-app traces.

### Find it

```sql
SELECT 'count:'||COUNT(*)||' avg_ms:'||(AVG(dur)/1e6)
FROM slice WHERE name='checkNetwork';
```

From the captured before-trace: **464 calls in 8 s, 2.29 ms per
call** — 1 ms+ per frame is significant on its own; multiply by a
real app's 10–20 such patterns and the budget evaporates.

In the trace UI, scroll the Binder Transactions track for
`system_server`. Each `checkNetwork` slice on the app side has a
matching transaction on the receiving side — the system_server
binder thread pool fills up with these.

![Buggy trace zoomed onto a `checkNetwork` slice. Every onPreDraw fires one cross-process binder call to system_server's ConnectivityService.](../images/binder-spam/before.png)

### Fix

Subscribe once via `NetworkCallback`; cache the answer locally;
read the cached value per frame.

```java
ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
    @Override public void onAvailable(Network n) { isConnected.set(true); }
    @Override public void onLost(Network n) { isConnected.set(false); }
};
cm.registerDefaultNetworkCallback(cb);

root.getViewTreeObserver().addOnPreDrawListener(() -> {
    Trace.beginSection("checkNetwork");
    try { t.setText("net=" + isConnected.get()); }
    finally { Trace.endSection(); }
    return true;
});
```

### Verify

Same SQL, after-trace: **470 calls, 0.54 ms per call** — 4.2×
faster. The remaining 0.54 ms is the per-frame cost of running the
listener at all (text formatting, view tree work). The binder
call is gone.

![Fixed trace zoomed onto a `checkNetwork` slice. Same call rate, no binder transaction underneath — the work now reads from a cached AtomicBoolean.](../images/binder-spam/after.png)

Zoom out and the wider context reflects the same change. The
`system_server` binder tracks are quiet during the same window.
The app process row is also quieter — fewer scheduling events,
because the listener no longer wakes the binder thread pool:

![Fixed BinderSpamDemo process with checkNetwork slices but no matching binder activity on system_server. The listener is now a pure-local read.](../images/binder-spam/after-wide.png)

The cost saved by killing one per-frame binder call is small in
isolation. The reason this matters in real apps is that
`getActiveNetworkInfo` is one of *dozens* of system services
that look "free" but cost a binder round trip — `getDisplayInfo`,
`getDisplayMetrics`, `getRunningAppProcesses`, `getMyMemoryState`,
location, sensors, accessibility. Per-frame pings to any of these
add up to several milliseconds of pure overhead before your app
has done any actual work.

## Second pattern: ContentObserver-backed LiveData

A common variant: `ContentObserver` notifications cause the
UI to re-query the provider, and each query is a binder call.
Same shape in the trace (per-frame binder pings to one provider),
different fix (debounce + local state mirror).

## See also

- [Frame jank](frame-jank.md) — when binder spam is what's
  pushing your frames over the deadline.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/binder-spam>
