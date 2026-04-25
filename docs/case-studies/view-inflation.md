# View inflation jank

When a `RecyclerView`/`ListView` row is a deeply-nested view tree,
each bind spends most of its time in `measure` and `layout` — not
in any user code. The trace shows a different shape than allocation
or decode jank: the bind slice is short, but `View.measure` /
`View.layout` slices stack inside it.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.

## Capture

```
ftrace_events: "sched/sched_switch"
atrace_categories: "view"
atrace_categories: "gfx"
atrace_categories: "sched"
atrace_apps: "com.example.perfetto.viewinflation"
```

The `view` atrace category is what surfaces the `measure`/`layout`
slices on the UI thread. Without it the bind slice looks
small-but-slow with no visible explanation.

Full config:
[`trace-configs/inflate.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/view-inflation/trace-configs/inflate.cfg).

## Case study: 30-deep nested LinearLayout per row

The adapter constructs a fresh nested-LinearLayout per row, 30
levels deep:

```java
LinearLayout outer = new LinearLayout(ctx);
LinearLayout cur = outer;
for (int i = 0; i < 30; i++) {
    LinearLayout child = new LinearLayout(ctx);
    cur.addView(child);
    cur = child;
}
```

Each scroll causes the framework to walk the entire 30-deep tree
twice (`measure` then `layout`) per visible row.

### Find it

```sql
SELECT name||' n='||COUNT(*)||' avg_ms='||(AVG(dur)/1e6)
FROM slice WHERE name LIKE '%Adapter.getView' GROUP BY name;
```

Before-trace: **DeepAdapter.getView, 351 calls, 3.12 ms each.**

![Buggy trace zoomed onto a `DeepAdapter.getView` slice. The slice contains nested measure/layout slices for the 30-level tree; the main thread spends most of its time walking the hierarchy, not in user code.](../images/view-inflation/before.png)

### Fix

Flatten the layout. A `TextView` is enough for the demo's
content:

```java
TextView tv = (TextView) convertView;
if (tv == null) {
    tv = new TextView(ctx);
    tv.setMinHeight(180);
    tv.setPadding(24, 24, 24, 24);
}
tv.setText("Row " + position);
return tv;
```

For real layouts, `ConstraintLayout` lets you express most
designs with a single-level view tree.

### Verify

After-trace: **FlatAdapter.getView, 354 calls, 0.41 ms each —
7.6× faster.**

![Fixed trace zoomed onto a `FlatAdapter.getView` slice. Same UI thread, ~0.41 ms slice; no nested measure/layout work because the row is a single TextView.](../images/view-inflation/after.png)

## Second pattern: deeply nested `ConstraintLayout` chains

Even `ConstraintLayout` can produce deep measure passes if
chains are mis-configured (e.g. circular or under-constrained).
Same shape in the trace — `measure` slices nest deeply on a
single bind. The fix is to add explicit constraints or use the
Layout Inspector to flatten manually.

## See also

- [Frame jank](frame-jank.md) — when the cost is in the bind body
  rather than the view tree.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/view-inflation>
