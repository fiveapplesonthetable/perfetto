# Java heap profile: object growth over time

When Java memory grows but you don't know what's holding it, the
right tool is a sequence of heap profile snapshots taken over the
suspect window. Perfetto's `android.java_hprof` data source with
`continuous_dump_config` captures one snapshot every N
milliseconds and writes them all into the same trace, so you can
compare them side-by-side to see what's growing.

This is part of the
[Android performance tutorials](perf-tutorial-series.md) series.
For a single-snapshot, post-hoc *Heap Dump Explorer* analysis of
retention paths, see the
[Heap Dump Explorer](/docs/visualization/heap-dump-explorer.md)
guide.

## Capture

The reference is upstream at
[`test/configs/java_hprof.cfg`](https://github.com/google/perfetto/blob/main/test/configs/java_hprof.cfg).
Continuous-dump configuration:

```
data_sources {
  config {
    name: "android.java_hprof"
    java_hprof_config {
      process_cmdline: "com.example.perfetto.heapalloc"
      continuous_dump_config {
        dump_phase_ms: 2000      # first snapshot 2 s after capture starts
        dump_interval_ms: 2000   # then every 2 s
      }
    }
  }
}
```

A 14-second capture with these intervals produces 5–6 snapshots —
enough to see growth but not so many that the trace bloats.

Full tutorial config:
[`trace-configs/heapalloc.cfg`](https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/java-heap-alloc/trace-configs/heapalloc.cfg).

## Case study: a static "cache" that's never evicted

A search/lookup screen accumulates entries in a static `List` for
"caching", but never evicts. The list grows linearly with use:

```java
public static final List<String> CACHE = new ArrayList<>();

private void onTick() {
    for (int i = 0; i < 5000; i++) {
        CACHE.add("entry-" + n + "-" + i);
    }
}
```

Each tick adds 5,000 fresh `String` objects. Twelve ticks = 60,000
strings pinned forever, growing the heap by ~3 MiB on top of the
framework baseline.

### Find it: compare snapshots

The data source emits one snapshot per `dump_interval_ms`. Each
snapshot is queryable via `heap_graph_object` rows tagged with the
sample timestamp:

```sql
SELECT graph_sample_ts/1e9       AS sec,
       COUNT(*)                  AS objects,
       SUM(self_size)/1024       AS kib
FROM heap_graph_object
WHERE upid = (SELECT upid FROM process WHERE name = 'com.example.perfetto.heapalloc')
GROUP BY graph_sample_ts
ORDER BY sec;
```

Buggy trace, 5 snapshots over 8 s:

| sec | objects | kib |
|---|---|---|
| 0 | 342,613 | 23,113 |
| 2 | 390,132 | 25,193 |
| 4 | 430,205 | 26,288 |
| 6 | 470,277 | 27,199 |
| 8 | 338,797 | 24,263 |

Every snapshot is bigger than the last while the demo is
allocating; the final snapshot drops because `am dumpheap`'s
implicit GC reclaims unused space at trace end. The growth rate
across snapshots is the diagnostic — a healthy app's snapshots
fluctuate around a baseline rather than rising monotonically.

In the UI, every snapshot appears as a diamond on the process's
**Heap Profile** track. Click any diamond to load that snapshot's
heap into the bottom panel:

![Buggy trace, com.example.perfetto.heapalloc process expanded. Multiple Heap Profile diamonds visible across the process timeline. Bottom panel: "Java heap graph", Object Size 23.41 MiB total, flamegraph rooted at byte[] / int[] / long[] / java.lang.String — the heap composition for one snapshot.](../images/java-heap-alloc/before-snapshots.png)

For per-class diff between two snapshots, the
[Heap Dump Explorer](/docs/visualization/heap-dump-explorer.md)
is the right tool — open the trace, pick the latest diamond, and
read the *Classes* tab sorted by Retained.

### Fix

Bound the cache. `LruCache` evicts the oldest entry past a fixed
capacity:

```java
public static final LruCache<String, String> CACHE = new LruCache<>(1024);

private void onTick() {
    for (int i = 0; i < 5000; i++) {
        String k = "entry-" + n + "-" + i;
        CACHE.put(k, k);
    }
}
```

Insertion rate is unchanged — the same 5,000 puts/sec. But the
cache holds at most 1,024 entries; everything past that gets
evicted to GC immediately.

### Verify

After-trace, 5 snapshots over 8 s:

| sec | objects | kib |
|---|---|---|
| 0 | 357,384 | 23,330 |
| 2 | 415,120 | 25,619 |
| 4 | 465,190 | 26,842 |
| 6 | 515,265 | 28,065 |
| 8 | 292,012 | 22,517 |

Comparable to the buggy trace at first glance — both show heap
growth as the demo runs. The difference is what's *retained*: in
the buggy trace, the static `CACHE` list keeps every string alive;
in the fixed trace, only the last 1,024 are reachable, the rest
are unreachable garbage waiting to be collected. ART's Background
GC eventually reclaims the unreachable, which is why the final
snapshot is smaller than in the buggy trace.

![Fixed trace, same process expanded. Same Heap Profile diamond pattern over time, but the final snapshot's flamegraph (right panel) shows fewer reachable instances of the demo's String type — most of the allocations have been collected.](../images/java-heap-alloc/after-snapshots.png)

The single-number scorecard, per-snapshot:

```sql
-- Find the largest snapshot's app-attributable retained bytes.
SELECT MAX(s.retained) / 1e6 AS peak_mb
FROM (
  SELECT graph_sample_ts, SUM(self_size) AS retained
  FROM heap_graph_object
  WHERE upid = (SELECT upid FROM process WHERE name = 'com.example.perfetto.heapalloc')
  GROUP BY graph_sample_ts
) s;
```

Track this across releases. Monotonic growth across snapshots in
a single trace, or peak growth across releases, is the regression
signal.

## Second pattern: autoboxing-driven retention

A common variant in Kotlin code that crosses Java APIs: a
`List<Long>` becomes a `List<Long>` (boxed `Long` objects). Each
element pins ~24 bytes of heap that wouldn't exist with primitive
`LongArray`. The continuous-snapshot pattern shows the same
shape — count of `java.lang.Long` rising linearly with collection
size. Fix: switch to primitive collections
(`LongArray`, `androidx.collection.LongSparseArray`).

## See also

- [Heap Dump Explorer](/docs/visualization/heap-dump-explorer.md)
  — for retention-graph analysis on a single snapshot (find what
  is keeping each retained object alive).
- [GC pauses](gc-pauses.md) — for the runtime *consequence* of
  high allocation rates.
- [Java heap dumps](/docs/data-sources/java-heap-profiler.md) —
  the upstream reference for the `android.java_hprof` data source.
- Repro artifacts:
  <https://github.com/fiveapplesonthetable/perfetto/tree/perf-tutorials-artifacts/java-heap-alloc>
