# Perfetto Java SDK emit benchmark — HL vs LL, on a real ARM device

Throwaway investigation tooling + methodology record (not for production
check-in). It documents how the Java track-event emit path (the Low-Level
`PerfettoEvent`/`ProtoWriter` path) was benchmarked against the existing
High-Level native ABI on a **real arm64 device**, so another agent can
reproduce the numbers exactly and continue the optimization work.

The two production CLs that came out of this investigation are the commits
immediately below this one on the `dev/zezeozue/java-protowriter-opt` stack:

- **deterministic single-copy LL frame encode**
- **cache process/thread track uuids on the emit path**

This doc covers: why a standalone benchmark, how the APK is built from the
perfetto GitHub repo only, how AOT compilation is **forced and verified** (the
single most error-prone part), how to run + profile, and the findings.

---

## TL;DR findings

- **LL wins decisively whenever the event carries a payload** — debug args
  (up to ~7.7× faster than HL at 16 args), strings, mixed args, proto fields,
  many-field counters. These are the events that dominate real traces.
- **LL trails HL only on the *degenerate empty event*** (`instant`/`slice`/bare
  `counter`/single track-or-flow), by ~8–30%. That is the architectural floor:
  with no elements to batch, LL must encode-in-Java + cross to native + let
  native parse, while HL's single minimal native call is already optimal. The
  only way past it is writing the protobuf **directly into the shared-memory
  buffer (SMB)** from Java (zero copy, zero per-event crossing) — tracked as a
  **separate investigation branch**, not here.
- A real bug was found and fixed: the frame encoder dropped to the **ART
  interpreter** on small events under some dexopt states (see Findings).

---

## Why standalone (the hard requirements)

The benchmark had to be apples-to-apples and uncontaminated:

1. **Perfetto GitHub repo only** — no AOSP/Soong build, no Android OS build.
   The stack's own `tools/benchmark_java_sdk_device.sh` shells out to Soong
   (`m perfetto_trace_instrumentation_test`) and defaults to a Cuttlefish
   **x86_64** lunch — wrong for a real-ARM, no-OS-build requirement. This
   harness builds only the perfetto JNI lib + the SDK + a driver into an APK.
2. **No framework perfetto** — the APK must bundle and load *its own*
   `dev.perfetto.sdk` classes + `libperfetto_jni.so`; the device framework's
   perfetto must never resolve, or it skews results. The driver logs provenance
   at startup proving classes + `.so` come from `/data/app`, never `/system`.
3. **Fair compilation** — both HL and LL Java must be **AOT-compiled** (not
   interpreted/JIT-warmup-dependent), verified on device. See "Forced AOT".
4. **Real ARM device** — a rooted Pixel 4 XL (`coral`, arm64-v8a, SDK 33).

---

## Environment (paths used in this workspace)

| Thing | Path |
|---|---|
| perfetto checkout (this stack) | `/mnt/agent/perfetto/bench-wt` |
| standalone harness | `/mnt/agent/perfetto-benchkit` (a copy lives here under `harness/`) |
| Android NDK (r26c, fetched by perfetto) | `buildtools/ndk` (via `tools/install-build-deps --android`) |
| `android.jar` (API 34) | `/mnt/agent/aosp/prebuilts/sdk/34/public/android.jar` |
| `aapt2`, `apksigner` | `/mnt/agent/aosp/prebuilts/sdk/tools/linux/...` |
| `d8`/`r8.jar` | `/mnt/agent/aosp/prebuilts/r8/r8.jar` |
| `zipalign` | `/mnt/agent/aosp/prebuilts/build-tools/linux-x86/bin/zipalign` |
| device adb (host adb server) | `ADB_SERVER_SOCKET=tcp:192.168.122.1:5037` + `adb -s 94LBA009A6` (the `padb` alias) |
| oatdump / simpleperf | on device: `/apex/com.android.art/bin/oatdump`, `/system/bin/simpleperf` |

The build/run scripts (`harness/*.sh`) hardcode these; adjust for another box.

---

## 1. Build the native lib (`libperfetto_jni.so`, arm64)

```sh
cd /mnt/agent/perfetto/bench-wt
tools/install-build-deps --android          # one-time: fetches gn/ninja/clang + NDK r26c
tools/gn gen out/android --args='target_os="android" target_cpu="arm64" is_debug=false'
tools/ninja -C out/android libperfetto_jni
# Produces out/android/stripped/{libperfetto_jni.so, libperfetto_c.so} (BOTH are
# needed in the APK -- libperfetto_jni dynamically links libperfetto_c).
```

`perfetto_android_jni_library` in `gn/perfetto_android_sdk.gni` expands to a
real `shared_library`, so GN/Ninja builds the `.so`. The APK packaging (Java →
dex → apk) is NOT done by GN — that's the harness below.

## 2. Build the benchmark APK (`harness/build_apk.sh`)

No AOSP, no androidx, no proto-java runtime:

- **javac** the 7 SDK sources (`src/android_sdk/java/main/dev/perfetto/sdk/*.java`)
  + the driver + three **compile-only annotation stubs** (see below), against
  `android.jar` (API 34). `-source 17 -target 17`, no `-bootclasspath` (modern
  javac forbids it with target 17; `java.*` resolves from the JDK, which is fine
  for these APIs).
- **d8** only the `dev/` classes → `classes.dex`. The stubs are deliberately
  **not dexed** (see below).
- **aapt2 link** a self-instrumenting manifest (no resources) → base apk.
- add `classes.dex` + `lib/arm64-v8a/{libperfetto_jni,libperfetto_c}.so`,
  `zipalign`, `apksigner` (debug key).

### Annotation stubs (`harness/stubs/`)

The SDK references `dalvik.annotation.optimization.{CriticalNative,FastNative}`
(hidden in the platform, absent from the public `android.jar`) and
`com.google.errorprone.annotations.CompileTimeConstant`. We provide compile-only
stubs and **exclude them from the dex**:

- `CriticalNative`/`FastNative` → `@Retention(CLASS)`: the annotation descriptor
  stays on the method in the dex, so **ART resolves the *real* platform
  annotation** (boot classpath) at link time and applies the cheap calling
  convention. The stub class itself is not dexed.
- `CompileTimeConstant` → `@Retention(SOURCE)`: vanishes after compile, no dex
  or runtime trace.

`sun.misc.Unsafe` (if you experiment with it) needs no stub — compile against
the JDK's `jdk.unsupported` module; but note **Android's `sun.misc.Unsafe`
lacks the `copyMemory(Object,...)` overload**, and `Unsafe.putByte(long,byte)`
is **not** intrinsified on this ART (it's a real call) — both dead ends found
the hard way.

## 3. The driver (`harness/.../BenchInstrumentation.java`)

A plain `android.app.Instrumentation` (no androidx/JUnit — only the framework
test harness, which is unrelated to the *perfetto* framework). It:

- Reads `impl` (`hl`|`ll`), `iters`, `warmup`, `trials`, optional `scenario`
  (exact-match filter) from the instrumentation args.
- Sets `System.setProperty("perfetto.use_java_emit", ...)` in `onCreate`
  **before** `PerfettoTrackEventBuilder` class-loads (its `sUseJavaEmit` is read
  once at class init).
- Logs provenance from `/proc/self/maps` + the classloader (proves no framework
  perfetto), starts a `PerfettoTrace.Session` with a precomputed `TraceConfig`
  (`BenchConfig`, generated once via `protoc --encode`), runs the scenarios, and
  logs `PERFBENCH <impl> <scenario> <ns_per_op>` per scenario.

Scenarios mirror the checked-in `PerfettoDeviceBenchmark` exactly: `instant`,
`slice`, `instant_int_args/{1,2,4,8,16}`, `instant_string_args/4`,
`instant_mixed_args/3`, process/thread tracks, `instant_flows/{1,2,4}`,
`counter_int`, `counter_double`, `instant_proto_fields/{1,4}`.

`am instrument` is run with `--no-hidden-api-checks` (mirrors the platform SDK's
full access; needed if you exercise `sun.misc.Unsafe`).

## 4. Forced AOT compilation + verification (THE critical part)

`cmd package compile -m speed -f <pkg>` compiles the whole app dex — including
the bundled SDK — so both HL and LL Java paths are AOT-compiled. But there are
two traps that silently leave code **interpreted** and ruin the comparison:

1. **`adb install` does an Incremental/streamed install by default**, for which
   dexopt is deferred → `dumpsys package dexopt` shows `status=run-from-apk`
   (interpreted). **You MUST `adb install -r -t --no-incremental`.**
2. A stale process: `am instrument` can reuse a process started *before* the AOT
   compile. `am force-stop <pkg>` before each run.

Verify three ways (all in `run_bench.sh` / done manually):

```sh
# (a) dexopt status must be 'speed'
adb shell dumpsys package dexopt | grep -A2 dev.perfetto.sdk.test     # [status=speed]
# (b) per-method compiled code in the odex (NOT (no code) / code_offset=0)
APKDIR=$(adb shell pm path dev.perfetto.sdk.test | sed 's/package://;s#/base.apk##' | tr -d '\r')
adb shell "su -c '/apex/com.android.art/bin/oatdump --oat-file=$APKDIR/oat/arm64/base.odex \
   --class-filter=ProtoWriter'" | grep 'CODE: (code_offset'        # all non-zero
# (c) simpleperf shows ~0 time in ExecuteNterpImpl / NterpGetShorty (the interpreter)
```

**Pitfall that cost real time:** setting `dalvik.vm.dex2oat-flags` to anything
invalid (we tried `--runtime-arg,-verbose:compiler` to get a skip reason) makes
dex2oat fail with error 256 and produce a *corrupt* odex, which then reads as
"uncompiled" — a red herring. Reset it: `setprop dalvik.vm.dex2oat-flags ""`.

Note: a *manual* `dex2oat --compiler-filter=speed` (no input vdex / swap) and
the *installd* path can differ on whether a borderline method compiles; always
verify on the **installd-produced** `base.odex`, which is what production uses.

## 5. Run

```sh
cd /mnt/agent/perfetto-benchkit            # or the harness/ copy
./build_apk.sh all                          # native .so must already be built (step 1)
./run_bench.sh 400000 40000 3               # iters warmup trials -> HL-vs-LL table
```

`run_bench.sh` installs `--no-incremental`, forces AOT, asserts `status=speed`,
runs `hl` then `ll` in fresh processes, and prints `scenario | HL | LL | LL/HL`.

## 6. Profile (simpleperf)

```sh
./profile.sh ll counter_int                 # records one scenario, top symbols
# manual: am instrument (single scenario, big iters) in bg, pidof, then
# simpleperf record -p <pid> -g -f 4000 --duration 8 ; simpleperf report --sort symbol
```

simpleperf is the **trustworthy** profiler here. In-path `System.nanoTime()`
stage probes were tried and discarded: the probe overhead is large relative to a
~500 ns emit, and the extra timed method de-optimised the real `emitJava` (a
global LL regression), so its absolute numbers were unreliable.

---

## Findings (what the profiles showed)

1. **`encodeFrame` was running in the ART interpreter (~17% on small events).**
   It encoded the frame via per-field virtual `ByteBuffer.putInt/putLong`; that
   method shape was not reliably AOT-compiled by installd. **Fix (landed):**
   encode the frame into a `byte[]` with small little-endian helpers, appended
   after the body in `ProtoWriter`'s own array (`reserveTail`), then one
   `DirectByteBuffer.put` to off-heap. Now compiles in every dexopt mode; wire
   format byte-identical (native untouched). Confirmed via oatdump.
2. **The off-heap copy is cheap (~70 ns).** Not worth chasing. An `Unsafe`
   detour (writing the frame straight off-heap via `putByte`) was *slower*
   because `Unsafe.putByte(long,byte)` is **not** intrinsified on this ART
   (a real native call each — ~20 per frame). Reverted.
3. **Two native crossings vs HL's one.** LL crossed twice (`DirectByteBuffer
   .put` to stage off-heap, then a `@CriticalNative` emit). A single-crossing
   `native_emit2(byte[], …)` (regular JNI + `GetByteArrayRegion`) was prototyped
   and measured a modest win on bodied events (`int_args/1` reached parity) but
   did **not** flip the truly empty events — so it was **not landed** (it also
   reverses the "off-heap + CriticalNative" design CL; deferred).
4. **Per-emit track-uuid native call.** `getProcessTrackUuid()` /
   `getThreadTrackUuid()` crossed into native (`@CriticalNative`) on *every*
   track/counter emit, though the value is constant. **Fix (landed):** cache the
   process uuid in a static and the thread uuid per calling thread. counter emit
   ~610 → ~585 ns/op.
5. **The native LL and HL paths do structurally equivalent work** (both iterate
   instances via the same `PerfettoTeLlImplBegin`, begin a packet on the SMB,
   intern, write the `TrackEvent`). So there is no big native-side waste; the LL
   small-event gap is the irreducible encode + extra-crossing cost.

### Representative results (`400000 40000 3`, Pixel 4 XL, AOT speed)

| scenario | LL/HL |
|---|---|
| instant_int_args/16 | **0.13×** |
| instant_int_args/8 | **0.18×** |
| instant_string_args/4 | 0.64× |
| instant_proto_fields/4 | 0.81× |
| instant_mixed_args/3 | 0.87× |
| instant | ~1.08× ✗ |
| slice | ~1.22× ✗ |
| instant_process_track / thread_track | ~1.06–1.10× ✗ |
| instant_flows/1–2 | ~1.04–1.10× ✗ |
| counter_int / counter_double | ~1.27–1.33× ✗ |

(Run-to-run noise is ~5–10% near the 1.0× line; use 1M×5 for borderline rows.)

---

## Next: SMB zero-copy (separate investigation branch)

To beat HL even on the empty event, write the `TrackEvent` protobuf **directly
into perfetto's shared-memory chunk** from Java — no Java buffer, no copy, no
per-event JNI emit. The public ABI exposes the writer's chunk pointers
(`PerfettoStreamWriter { begin; end; write_ptr; }` in
`include/perfetto/public/abi/stream_writer_abi.h`), and `ProtoWriter` already
does the protozero redundant-4-byte length-prefix patching. The hard parts:
exposing the SMB chunk lifecycle (begin/commit/new-chunk) to Java, cross-chunk
patching (the patch list), and coordinating per-sequence interning/incremental
state. This is a substantial, correctness-sensitive effort and lives on its own
branch, not on this opt stack.
