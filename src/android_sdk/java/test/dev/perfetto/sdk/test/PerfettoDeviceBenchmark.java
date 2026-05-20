/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// THROWAWAY (not for check-in): on-device A/B benchmark of the Java SDK emit
// path, HL vs LL, driven by tools/benchmark_java_sdk_device.sh. The impl is
// chosen per-process from the instrumentation arg "impl" (hl|ll), which sets the
// perfetto.use_java_emit flag BEFORE the builder class loads. Results are logged
// to logcat as "PERFBENCH <impl> <scenario> <ns_per_op>".
package dev.perfetto.sdk.test;

import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import dev.perfetto.sdk.PerfettoTrace;
import dev.perfetto.sdk.PerfettoTrace.Category;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import perfetto.protos.DataSourceConfigOuterClass.DataSourceConfig;
import perfetto.protos.TraceConfigOuterClass.TraceConfig;
import perfetto.protos.TraceConfigOuterClass.TraceConfig.BufferConfig;
import perfetto.protos.TraceConfigOuterClass.TraceConfig.DataSource;
import perfetto.protos.TrackEventConfigOuterClass.TrackEventConfig;

@RunWith(AndroidJUnit4.class)
public class PerfettoDeviceBenchmark {
  private static final String TAG = "PERFBENCH";
  private static final String CAT = "bench";
  private static final Category C = new Category(CAT);

  private static String sImpl;
  private static int sWarmup;
  private static int sIters;
  private static int sTrials;

  @BeforeClass
  public static void setUpClass() {
    Bundle args = InstrumentationRegistry.getArguments();
    sImpl = getArg(args, "impl", "ll");
    sWarmup = Integer.parseInt(getArg(args, "warmup", "100000"));
    sIters = Integer.parseInt(getArg(args, "iters", "1000000"));
    sTrials = Integer.parseInt(getArg(args, "trials", "5"));
    // MUST happen before PerfettoTrackEventBuilder loads (its flag is a static
    // final read at class init). No emit has happened yet at this point.
    System.setProperty("perfetto.use_java_emit", String.valueOf("ll".equals(sImpl)));

    System.loadLibrary("perfetto_jni");
    PerfettoTrace.register(true);
    var unused = C.register();
  }

  @Test
  public void run() {
    PerfettoTrace.Session session = new PerfettoTrace.Session(true, config().toByteArray());

    final String[] argNames = argNames(); // distinct keys so emit allocates nothing extra

    bench("instant", () -> PerfettoTrace.instant(C, "e").emit());
    bench(
        "slice",
        () -> {
          PerfettoTrace.begin(C, "s").emit();
          PerfettoTrace.end(C).emit();
        });

    for (int n : new int[] {1, 2, 4, 8, 16}) {
      final int count = n;
      bench(
          "instant_int_args/" + n,
          () -> {
            var b = PerfettoTrace.instant(C, "e");
            for (int i = 0; i < count; i++) {
              b.addArg(argNames[i], (long) i);
            }
            b.emit();
          });
    }
    bench(
        "instant_string_args/4",
        () -> {
          var b = PerfettoTrace.instant(C, "e");
          for (int i = 0; i < 4; i++) {
            b.addArg(argNames[i], "v");
          }
          b.emit();
        });
    bench(
        "instant_mixed_args/3",
        () ->
            PerfettoTrace.instant(C, "e")
                .addArg(argNames[0], 42L)
                .addArg(argNames[1], true)
                .addArg(argNames[2], "v")
                .emit());

    bench(
        "instant_process_track",
        () -> PerfettoTrace.instant(C, "e").usingProcessNamedTrack(7, "track").emit());
    bench(
        "instant_thread_track",
        () ->
            PerfettoTrace.instant(C, "e")
                .usingThreadNamedTrack(8, "track", android.os.Process.myTid())
                .emit());

    for (int n : new int[] {1, 2, 4}) {
      final int count = n;
      bench(
          "instant_flows/" + n,
          () -> {
            var b = PerfettoTrace.instant(C, "e");
            for (int i = 0; i < count; i++) {
              b.addFlow(100 + i);
            }
            b.emit();
          });
    }

    bench("counter_int", () -> PerfettoTrace.counter(C, 42).usingProcessCounterTrack("ctr").emit());
    bench(
        "counter_double",
        () -> PerfettoTrace.counter(C, 3.5).usingProcessCounterTrack("ctr").emit());

    for (int n : new int[] {1, 4}) {
      final int count = n;
      bench(
          "instant_proto_fields/" + n,
          () -> {
            var b = PerfettoTrace.instant(C, "e").beginProto();
            for (int i = 0; i < count; i++) {
              b.addField(i + 1, (long) i);
            }
            b.endProto().emit();
          });
    }

    session.close();
    Log.i(TAG, "PERFBENCH_DONE impl=" + sImpl);
  }

  private interface Op {
    void run();
  }

  private static void bench(String scenario, Op op) {
    for (int i = 0; i < sWarmup; i++) {
      op.run();
    }
    double best = Double.MAX_VALUE;
    for (int t = 0; t < sTrials; t++) {
      long start = System.nanoTime();
      for (int i = 0; i < sIters; i++) {
        op.run();
      }
      best = Math.min(best, (double) (System.nanoTime() - start) / sIters);
    }
    Log.i(TAG, String.format("PERFBENCH %s %s %.1f", sImpl, scenario, best));
  }

  private static String[] argNames() {
    String[] names = new String[16];
    for (int i = 0; i < names.length; i++) {
      names[i] = "arg_" + i;
    }
    return names;
  }

  private static String getArg(Bundle args, String key, String def) {
    String v = args == null ? null : args.getString(key);
    return v == null ? def : v;
  }

  private static TraceConfig config() {
    BufferConfig buffer = BufferConfig.newBuilder().setSizeKb(8192).build();
    TrackEventConfig te = TrackEventConfig.newBuilder().addEnabledCategories(CAT).build();
    DataSourceConfig ds =
        DataSourceConfig.newBuilder()
            .setName("track_event")
            .setTargetBuffer(0)
            .setTrackEventConfig(te)
            .build();
    return TraceConfig.newBuilder()
        .addBuffers(buffer)
        .addDataSources(DataSource.newBuilder().setConfig(ds).build())
        .build();
  }
}
