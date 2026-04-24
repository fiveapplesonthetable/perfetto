# heap-docs-artifacts — reproducing the case studies

Everything needed to regenerate the screenshots in
[`docs/visualization/heap-dump-explorer.md`](https://github.com/fiveapplesonthetable/perfetto/blob/heap-docs-screenshots/docs/visualization/heap-dump-explorer.md)
from scratch. Separate from the doc PR; review on its own.

## Layout

```
artifacts/
├── README.md                     (this file)
├── leakapp/                      (buggy demo — reproduces both case studies)
│   ├── AndroidManifest.xml
│   ├── assets/leaky.png          (128×128 PNG; 12 duplicate copies get decoded from this)
│   ├── build.sh                  (javac → d8 → aapt2 → zipalign → apksigner, AOSP prebuilts only)
│   └── src/com/heapleak/
│       ├── MainActivity.java     (fires both leaks on startup)
│       ├── ProfileActivity.java  (leak: static field `last` pins a destroyed Activity)
│       └── FeedAdapter.java      (leak: static `cache` list accumulates Bitmaps)
├── leakapp-fixed/                (same app, leaks removed)
│   └── src/com/heapleak/
│       ├── MainActivity.java     (calls LruCache by key, no static refs)
│       ├── ProfileActivity.java  (no static reference to this)
│       └── FeedAdapter.java      (LruCache<Integer, Bitmap>(4))
├── dumps/
│   ├── before.pftrace            (heap graph, buggy app, 19 MB)
│   ├── before.hprof              (ART HPROF -b png, buggy app, 45 MB)
│   ├── after.pftrace             (fixed app)
│   └── after.hprof               (fixed app)
├── screenshots/                  (raw PNGs from Playwright, superset of what landed in the doc)
└── playwright/
    ├── shoot_final.js            (main shooter: tab tour + case studies + verification)
    ├── shoot_objtab.js           (focused re-shoot for the Object tab flow)
    └── serve_dumps.py            (tiny CORS-enabled static server for trace_url= workflows)
```

## One-shot reproduction

Assumes a running cuttlefish at `adb devices` and the AOSP checkout at
`~/dev/aosp` (for prebuilt `aapt2`, `d8`, `apksigner`, `android.jar` API 36 and
the testkey). All paths in `leakapp/build.sh` resolve there.

```bash
# 1. Build the buggy app and capture its dumps.
cd ~/dev/heapdocs/artifacts/leakapp
./build.sh
adb install -r build/leakapp.apk
adb shell am force-stop com.heapleak
adb shell am start -n com.heapleak/.MainActivity
sleep 3                                   # leaks fire ~800 ms after onCreate

~/dev/heapdocs/perfetto/tools/java_heap_dump \
    -n com.heapleak -o ../dumps/before.pftrace

adb shell am dumpheap -g -b png com.heapleak /data/local/tmp/before.hprof
adb pull /data/local/tmp/before.hprof ../dumps/before.hprof

# 2. Build the fixed app and capture its dumps.
cd ~/dev/heapdocs/artifacts/leakapp-fixed
./build.sh
adb install -r build/leakapp.apk
adb shell am force-stop com.heapleak
adb shell am start -n com.heapleak/.MainActivity
sleep 3

~/dev/heapdocs/perfetto/tools/java_heap_dump \
    -n com.heapleak -o ../dumps/after.pftrace
adb shell am dumpheap -g -b png com.heapleak /data/local/tmp/after.hprof
adb pull /data/local/tmp/after.hprof ../dumps/after.hprof

# 3. Serve the locally-built Perfetto UI from this branch (heap_docs).
cd ~/dev/heapdocs/perfetto
tools/install-build-deps --ui                 # first time only
ui/build                                      # builds to ui/out/dist/
ui/run-dev-server --serve-host 127.0.0.1 --serve-port 10000 -n &
# Wait until http://127.0.0.1:10000 returns 200.

# 4. Shoot all screenshots. Writes to ../screenshots/.
cd ~/dev/heapdocs/artifacts/playwright
npm install playwright                        # first time only
npx playwright install chromium
node shoot_final.js
```

Screenshots land in `../screenshots/`. Compare against the ones in the
`docs/images/heap_docs/` folder on the PR branch.

## Mapping from bug in source → screenshot in the doc

| Source line | Screenshot landed as | What it shows |
|---|---|---|
| `ProfileActivity.java`: `public static ProfileActivity last` | `12-object-tab-top.png` | Reference Path `Class<ProfileActivity>` → `ProfileActivity.last` → `ProfileActivity` |
| `FeedAdapter.java`: `public static final List<Bitmap> cache` | `09-bitmaps-show-paths.png` | Every card: `Class<FeedAdapter>.cache` → `ArrayList` → `Bitmap` |
| `MainActivity.java`: 12-iteration `decodeByteArray` loop | `04-overview.png`, `08-bitmaps-gallery.png` | Overview: 12 copies, 785.8 KiB wasted. Bitmaps: 12 cards. |
| Fix applied (no static Activity ref, LruCache) | `15-fixed-overview.png` | Overview: "No duplicate bitmaps found", app heap 1.5 MiB → 580 KiB |

## Notes

- The HPROF (`am dumpheap -b png`) is required for the Bitmaps gallery to
  render pixels and for the Overview to detect duplicates. The pftrace (heap
  graph) only carries the object graph and GC roots — enough for the Activity
  leak case study on its own, but not for any `-b png` dependent shot.

- `-g` on `am dumpheap` forces a GC before the dump. Use it whenever you're
  chasing a leak — without it ART's conservative collector leaves dead objects
  in the dump for a cycle or two and muddies the result.

- The Playwright shooter sets `localStorage.cookieAck='true'` before every
  page load, so the Perfetto cookie banner doesn't cover the viewport.

- The demo app targets API 36 (matches the cuttlefish device) and builds
  with no Gradle — just `javac` against the AOSP prebuilt `android.jar` and
  `core-lambda-stubs.jar`, `d8` into `classes.dex`, `aapt2 link` for the
  manifest+assets, then signing with the AOSP testkey. Runs on any debuggable
  Android, not just cuttlefish.
