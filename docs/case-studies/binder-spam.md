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
