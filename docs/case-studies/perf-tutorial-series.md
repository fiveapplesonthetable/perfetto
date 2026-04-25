# Android performance tutorials

A series of tutorials walking through the major shapes of Android
performance investigation in Perfetto. Each tutorial:

- Ships a small reproducible demo app (buggy + fixed builds).
- Includes a Perfetto trace config that captures exactly what the
  doc references.
- Shows headline screenshots from a captured trace, with concrete
  numbers from the demo.
- Ends with a verify step backed by a second screenshot of the
  fixed trace.
- Has a paired `artifacts/` subdirectory that anyone can re-run to
  regenerate every screenshot.

For the artifact pattern in detail, and the source-line → screenshot
map for each tutorial, see the artifacts branch:
<https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts>.

## Available

- [Frame jank](frame-jank.md) — synchronous bitmap decode in
  `getView`. 274/275 binds > 16 ms before, 0 after.
- [App startup](app-startup.md) — three SDKs initialised serially
  in `Application.onCreate`. `bindApplication` 2.6 s → 64 ms (41×).
- [Binder spam](binder-spam.md) — `ConnectivityManager` from
  `onPreDraw`. Per-frame cost 2.29 ms → 0.54 ms.
- [Lock contention](lock-contention.md) — long critical section on
  one mutex, 16-thread pool. 13.6× throughput.
- [Main-thread I/O](main-thread-io.md) — `SharedPreferences.commit`
  in a callback. 1.58 ms → 0.17 ms (9.2×).
- [Java heap allocations](java-heap-allocations.md) — fresh
  `ArrayList` + 5,000 fresh `String`s per keystroke.
- [GC pauses](gc-pauses.md) — `String + char` in a hot loop.
  236.9 ms → 0.80 ms (295×); 259 GC slices → 0.
- [CPU spinning](cpu-spinning.md) — O(n²) substring-based parser.
- [Short-lived thread spam](thread-spam.md) — one `Thread()` per
  request. 232 → 34 distinct threads in process.
- [Wakelocks](wakelocks.md) — `PowerManager.WakeLock.acquire()`
  without `release()`. Activate/deactivate count delta is the
  scorecard.
- [View inflation jank](view-inflation.md) — 30-deep nested
  `LinearLayout` per row. 3.12 ms → 0.41 ms (7.6×).
- [Database on UI thread](db-on-ui-thread.md) — `getWritableDatabase()`
  + heavy query in `onCreate`. 328 ms blocking → off-thread.
- [Native heap leaks](native-heap.md) — JNI `malloc()` without
  `free()`. 17 MB allocated, 17 MB net unreleased → 0 MB net.
  Uses the `heapprofd` data source.
- [Long-trace battery](long-trace-battery.md) — background poll
  that prevents Doze. 290 polls/min → 0. Uses the `long_trace.cfg`
  pattern + `android.power` + power ftrace events.

## Planned

(Every major shape — jank, startup, binder, lock, I/O, java
allocation, GC, CPU spinning, threads, wakelocks, view inflation,
DB on UI, native heap, long-trace battery — has a worked
tutorial. Further depth lives upstream in
[`/docs/data-sources/`](/docs/data-sources/).)

Each tutorial follows the same shape as the [Heap Dump
Explorer](/docs/visualization/heap-dump-explorer.md) doc: capture →
read the trace → fix → verify, with two case studies per topic
showing different surface shapes of the same bug class.

## Contributing a tutorial

Each tutorial gets its own subdirectory under `artifacts/<topic>/`
in the artifacts branch with this layout:

```
artifacts/<topic>/
├── README.md            one-shot reproduction + source-line → screenshot map
├── demo-buggy/          smallest app that reproduces the bug
│   ├── AndroidManifest.xml
│   ├── build.sh         AOSP prebuilts only, no Gradle
│   └── src/...
├── demo-fixed/          same app, fix applied
│   └── src/...
├── trace-configs/       textproto Perfetto configs
├── traces/              before.pftrace / after.pftrace
└── playwright/          shoot.js for screenshots
```

Hard rules for new tutorials:

- The bug must fire deterministically within a few seconds of
  `am start`, no manual interaction beyond at most one tap.
- The bug must be small — one file, ideally under 50 lines. Readers
  point at the bad line in a single screenshot.
- Buggy and fixed apps share package, Activity names, and UI — only
  the bad code path swaps. The doc's verify step becomes a one-line
  diff and a paired before/after screenshot.
- The trace config is checked in as a textproto, not described in
  prose.
- The Playwright shooter is idempotent: same trace in, same images
  out. Set `localStorage.cookieAck`, pin viewport, drive navigation
  via deep-link URL hashes.
- The artifact README maps each source line of the bug to the
  screenshot that visualises it. Reviewers verify the artifact PR
  without opening the doc PR.
- Two case studies per doc, not one — the reader learns the
  technique, not the example. Different surface shape, same trace
  view.
