# App startup

A slow cold start is one of the easiest user-visible wins to find
in a trace: the user taps the launcher and waits for a frame. The
gap between `am_proc_start` and the first `Choreographer#doFrame`
is the time-to-first-frame; whatever's running on the main thread
in that gap is what the user is waiting for.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.

## Capture

Trace must start *before* `am start`, otherwise the cold-start
window is gone. Capture for ~7 s with these atrace categories:

```
ftrace_events: "sched/sched_switch"
ftrace_events: "task/task_newtask"
atrace_categories: "am"  "wm"  "view"  "sched"  "binder_driver"
atrace_apps: "com.example.perfetto.startup"
```

Full config:
[`trace-configs/startup.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/app-startup/trace-configs/startup.cfg).

```bash
$ adb shell perfetto --txt -c /data/local/tmp/startup.cfg \
      -o /data/local/tmp/before.pftrace &
$ sleep 1                                # let perfetto start recording
$ adb shell am start -n com.example.perfetto.startup/.StartupActivity
$ wait
```

## Case study: serial SDK initialization in `Application.onCreate`

A team adds three SDKs (analytics, crash reporter, image loader)
during `Application.onCreate`. Each is initialised on the main
thread:

```java
public class StartupApp extends Application {
    @Override public void onCreate() {
        super.onCreate();
        initAnalytics();      // 550 ms
        initCrashReporter();  // 800 ms
        initImageLoader();    // 1200 ms
    }
}
```

Cold start now waits ~2.5 s before the launcher activity even
runs `onCreate`.

### Find it

Open the trace, find the app's main thread, look at the
`bindApplication` slice. From the captured before-trace:

```sql
SELECT name, dur/1e6 AS ms FROM slice
WHERE name IN ('bindApplication','Analytics.init','CrashReporter.init','ImageLoader.init')
ORDER BY ts;

bindApplication       2616.36
Analytics.init         550.77
CrashReporter.init     800.64
ImageLoader.init      1200.59
```

`bindApplication` runs to **2.6 s** and the three named slices
inside it match the `Trace.beginSection` calls each initialiser
wraps itself in. The breakdown is the punch list — every entry is
a candidate to move off the startup path.

![Buggy startup trace zoomed onto the `bindApplication` slice. Search bar shows "bindApplication"; the slice is highlighted on the main thread; the bottom-panel slice details report Duration ~2.6 s with most of it Sleeping (the SDK init `Thread.sleep` calls). Below, the Actual Frame Timeline shows no frames presented during this window.](../images/app-startup/before.png)

### Fix

Move the work to a background thread. Keep `Application.onCreate`
short:

```java
@Override public void onCreate() {
    super.onCreate();
    HandlerThread bg = new HandlerThread("AppInit");
    bg.start();
    Handler h = new Handler(bg.getLooper());
    h.post(this::initAnalytics);
    h.post(this::initCrashReporter);
    h.post(this::initImageLoader);
}
```

For real apps prefer the
[App Startup library](https://developer.android.com/topic/libraries/app-startup),
which gives ordered, lazy initializers without you owning a
background thread.

### Verify

Recapture; the same SQL on the fixed trace:

```
bindApplication          63.98
Analytics.init          550.41
CrashReporter.init      800.48
ImageLoader.init       1200.48
```

`bindApplication` is now **64 ms** — a 41× drop. The three SDK
inits still happen and still take the same time, but they happen
on the background thread after `Application.onCreate` has
returned, so the launcher activity gets to its first frame
immediately.

![Fixed startup trace zoomed onto the `bindApplication` slice. The slice is now ~64 ms wide; the three init slices have moved off the main thread (visible as separate slices on the AppInit background thread). The first Choreographer#doFrame slice fires almost immediately after.](../images/app-startup/after.png)

## Second pattern: ContentProvider init storm

Some libraries ship a `ContentProvider` purely as an init hook
(it runs before `Application.onCreate`). Ten libraries doing this
is 800 ms before your code even runs. The trace shows it the same
way — slices on the main thread before `bindApplication`. The
fix is the same: lazy init via App Startup, or remove the
`ContentProvider` if you control the library.

## See also

- [Frame jank](frame-jank.md) — for jank *after* the app is up.
- [atrace](/docs/data-sources/atrace.md) — categories used here.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/app-startup>
