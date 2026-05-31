/*
 * Standalone on-device HL-vs-LL emit benchmark for the Perfetto Java SDK.
 *
 * Plain android.app.Instrumentation (no androidx, no JUnit) so the APK bundles
 * ONLY the perfetto SDK from the GitHub repo + this driver + libperfetto_jni.so.
 * The framework's own perfetto must never be involved: at startup we log the
 * dex + native-lib provenance from /proc/self/maps and the classloader so we
 * can prove every measured class/.so came from /data/app/<this apk>, not /system.
 *
 * Scenario set + measurement loop mirror the checked-in PerfettoDeviceBenchmark
 * so numbers are directly comparable. Impl (hl|ll) is chosen from the "impl"
 * instrumentation arg, which sets perfetto.use_java_emit BEFORE the SDK builder
 * class loads (its flag is read once at class-init).
 *
 *   adb shell am instrument -w \
 *     -e impl ll -e iters 1000000 -e warmup 100000 -e trials 5 \
 *     dev.perfetto.sdk.test/dev.perfetto.sdk.bench.BenchInstrumentation
 *
 * Results land in logcat as: "PERFBENCH <impl> <scenario> <ns_per_op>".
 */
package dev.perfetto.sdk.bench;

import android.app.Instrumentation;
import android.os.Bundle;
import android.os.Process;
import android.util.Base64;
import android.util.Log;
import dev.perfetto.sdk.PerfettoEvent;
import dev.perfetto.sdk.PerfettoTrace;
import dev.perfetto.sdk.PerfettoTrace.Category;
import dev.perfetto.sdk.PerfettoTrackEventBuilder;
import dev.perfetto.sdk.ProtoWriter;
import java.io.BufferedReader;
import java.io.FileReader;
import java.lang.reflect.Field;
import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import sun.misc.Unsafe;

public final class BenchInstrumentation extends Instrumentation {
  private static final String TAG = "PERFBENCH";
  private static final String CAT = "bench";

  private Bundle argsBundle;
  private String impl;
  private String scenarioFilter; // if non-empty, only run scenarios containing it
  private boolean timing;
  private int warmup;
  private int iters;
  private int trials;

  private interface Op {
    void run();
  }

  @Override
  public void onCreate(Bundle args) {
    // MUST set the emit flag before any PerfettoTrace/PerfettoTrackEventBuilder
    // reference triggers class-init (sUseJavaEmit is read once there).
    argsBundle = args;
    impl = arg(args, "impl", "ll");
    scenarioFilter = arg(args, "scenario", "");
    timing = "1".equals(arg(args, "timing", "0"));
    warmup = Integer.parseInt(arg(args, "warmup", "100000"));
    iters = Integer.parseInt(arg(args, "iters", "1000000"));
    trials = Integer.parseInt(arg(args, "trials", "5"));
    boolean hb = "hb".equals(impl); // builder-integrated hybrid (HL + raw body)
    System.setProperty("perfetto.use_java_emit", String.valueOf("ll".equals(impl) || hb));
    System.setProperty("perfetto.use_hl_hybrid", String.valueOf(hb));
    super.onCreate(args);
    start(); // spawns the instrumentation worker thread -> onStart()
  }

  @Override
  public void onStart() {
    super.onStart();
    Bundle result = new Bundle();
    try {
      logProvenance();
      System.loadLibrary("perfetto_jni");
      logNativeProvenance();
      PerfettoTrace.register(/* isBackendInProcess= */ true);
      Category c = new Category(CAT);
      c.register();

      PerfettoTrace.Session session =
          new PerfettoTrace.Session(/* isBackendInProcess= */ true, BenchConfig.bytes());

      if ("1".equals(arg(argsBundle, "writebench", "0"))) {
        runWriteBench();
      } else {
        runScenarios(c);
      }

      session.close();
      Log.i(TAG, "PERFBENCH_DONE impl=" + impl);
      result.putString("bench_status", "ok");
    } catch (Throwable t) {
      Log.e(TAG, "PERFBENCH_FAIL impl=" + impl, t);
      result.putString("bench_status", "fail:" + t);
    }
    finish(0, result);
  }

  private void runScenarios(Category c) {
    final String[] argNames = argNames();

    bench("instant", () -> PerfettoTrace.instant(c, "e").emit());
    bench(
        "slice",
        () -> {
          PerfettoTrace.begin(c, "s").emit();
          PerfettoTrace.end(c).emit();
        });

    for (int n : new int[] {1, 2, 4, 8, 16}) {
      final int count = n;
      bench(
          "instant_int_args/" + n,
          () -> {
            PerfettoTrackEventBuilder b = PerfettoTrace.instant(c, "e");
            for (int i = 0; i < count; i++) {
              b.addArg(argNames[i], (long) i);
            }
            b.emit();
          });
    }
    bench(
        "instant_string_args/4",
        () -> {
          PerfettoTrackEventBuilder b = PerfettoTrace.instant(c, "e");
          for (int i = 0; i < 4; i++) {
            b.addArg(argNames[i], "v");
          }
          b.emit();
        });
    bench(
        "instant_mixed_args/3",
        () ->
            PerfettoTrace.instant(c, "e")
                .addArg(argNames[0], 42L)
                .addArg(argNames[1], true)
                .addArg(argNames[2], "v")
                .emit());

    bench(
        "instant_process_track",
        () -> PerfettoTrace.instant(c, "e").usingProcessNamedTrack(7, "track").emit());
    bench(
        "instant_thread_track",
        () ->
            PerfettoTrace.instant(c, "e")
                .usingThreadNamedTrack(8, "track", Process.myTid())
                .emit());

    for (int n : new int[] {1, 2, 4}) {
      final int count = n;
      bench(
          "instant_flows/" + n,
          () -> {
            PerfettoTrackEventBuilder b = PerfettoTrace.instant(c, "e");
            for (int i = 0; i < count; i++) {
              b.addFlow(100 + i);
            }
            b.emit();
          });
    }

    bench("counter_int", () -> PerfettoTrace.counter(c, 42).usingProcessCounterTrack("ctr").emit());
    bench(
        "counter_double",
        () -> PerfettoTrace.counter(c, 3.5).usingProcessCounterTrack("ctr").emit());

    for (int n : new int[] {1, 4}) {
      final int count = n;
      bench(
          "instant_proto_fields/" + n,
          () -> {
            PerfettoTrackEventBuilder b = PerfettoTrace.instant(c, "e").beginProto();
            for (int i = 0; i < count; i++) {
              b.addField(i + 1, (long) i);
            }
            b.endProto().emit();
          });
    }
  }

  // P0 substrate microbench for the SMB-direct design: how fast can Java write
  // a small packet (~5 longs = 40 bytes) into NATIVE memory? Compares
  // Unsafe.putLong(addr) vs a reused DirectByteBuffer absolute putLong vs a
  // byte[] baseline. Decides the Java->SMB writer substrate. Logs PERFWRITE.
  private void runWriteBench() {
    final int LONGS = 5;
    final int iters = 30_000_000;
    final int trials = 5;

    Unsafe u = acquireUnsafe();
    long mem = u.allocateMemory(64);
    ByteBuffer dbb = ByteBuffer.allocateDirect(64).order(ByteOrder.LITTLE_ENDIAN);
    byte[] arr = new byte[64];

    // unsafe putLong to a raw native address
    Op unsafeOp = () -> {
      for (int j = 0; j < LONGS; j++) {
        u.putLong(mem + (j << 3), 0x0102030405060708L + j);
      }
    };
    // reused DirectByteBuffer, absolute putLong (no per-op alloc)
    Op dbbOp = () -> {
      for (int j = 0; j < LONGS; j++) {
        dbb.putLong(j << 3, 0x0102030405060708L + j);
      }
    };
    // byte[] baseline (what ProtoWriter does today)
    Op arrOp = () -> {
      for (int j = 0; j < LONGS; j++) {
        long v = 0x0102030405060708L + j;
        int p = j << 3;
        arr[p] = (byte) v; arr[p + 1] = (byte) (v >>> 8); arr[p + 2] = (byte) (v >>> 16);
        arr[p + 3] = (byte) (v >>> 24); arr[p + 4] = (byte) (v >>> 32); arr[p + 5] = (byte) (v >>> 40);
        arr[p + 6] = (byte) (v >>> 48); arr[p + 7] = (byte) (v >>> 56);
      }
    };

    writeMeasure("unsafe_putLong_native", unsafeOp, iters, trials);
    writeMeasure("directbytebuffer_putLong", dbbOp, iters, trials);
    writeMeasure("bytearray_baseline", arrOp, iters, trials);
    u.freeMemory(mem);
  }

  private void writeMeasure(String name, Op op, int iters, int trials) {
    for (int i = 0; i < 1_000_000; i++) {
      op.run();
    }
    double best = Double.MAX_VALUE;
    for (int t = 0; t < trials; t++) {
      long s = System.nanoTime();
      for (int i = 0; i < iters; i++) {
        op.run();
      }
      best = Math.min(best, (double) (System.nanoTime() - s) / iters);
    }
    Log.i(TAG, String.format("PERFWRITE %s %.2f", name, best));
  }

  private static Unsafe acquireUnsafe() {
    try {
      Field f = Unsafe.class.getDeclaredField("theUnsafe");
      f.setAccessible(true);
      return (Unsafe) f.get(null);
    } catch (ReflectiveOperationException e) {
      throw new RuntimeException(e);
    }
  }


  private void bench(String scenario, Op op) {
    if (!scenarioFilter.isEmpty() && !scenario.equals(scenarioFilter)) {
      return;
    }
    for (int i = 0; i < warmup; i++) {
      op.run();
    }
    double best = Double.MAX_VALUE;
    for (int t = 0; t < trials; t++) {
      long start = System.nanoTime();
      for (int i = 0; i < iters; i++) {
        op.run();
      }
      best = Math.min(best, (double) (System.nanoTime() - start) / iters);
    }
    Log.i(TAG, String.format("PERFBENCH %s %s %.1f", impl, scenario, best));
  }

  // ---- provenance / fairness checks ---------------------------------------

  private void logProvenance() {
    ClassLoader cl = PerfettoTrace.class.getClassLoader();
    String src = "?";
    try {
      java.security.CodeSource cs = PerfettoTrace.class.getProtectionDomain().getCodeSource();
      if (cs != null && cs.getLocation() != null) {
        src = cs.getLocation().toString();
      }
    } catch (Throwable ignore) {
      // getProtectionDomain may be unsupported; classloader string still tells us.
    }
    Log.i(TAG, "PROVENANCE impl=" + impl + " sdk_class_loader=" + cl + " sdk_code_source=" + src);
  }

  private void logNativeProvenance() {
    try (BufferedReader r = new BufferedReader(new FileReader("/proc/self/maps"))) {
      String line;
      boolean found = false;
      while ((line = r.readLine()) != null) {
        if (line.contains("perfetto_jni")) {
          Log.i(TAG, "PROVENANCE native " + line.trim());
          found = true;
        }
      }
      if (!found) {
        Log.i(TAG, "PROVENANCE native libperfetto_jni.so not yet in maps");
      }
    } catch (Throwable t) {
      Log.i(TAG, "PROVENANCE native read failed: " + t);
    }
  }

  // ---- helpers ------------------------------------------------------------

  private static String[] argNames() {
    String[] names = new String[16];
    for (int i = 0; i < names.length; i++) {
      names[i] = "arg_" + i;
    }
    return names;
  }

  private static String arg(Bundle args, String key, String def) {
    String v = args == null ? null : args.getString(key);
    return v == null ? def : v;
  }
}
