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

package dev.perfetto.sdk.test;

import static com.google.common.truth.Truth.assertThat;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import dev.perfetto.sdk.ProtoWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * EXPERIMENTAL, TEST-ONLY (throwaway branch). The device-runnable side of the
 * body-encoding A/B: encode straight into a direct ByteBuffer vs the production
 * "encode into a heap byte[] then copy" strategy.
 *
 * <p>{@link #heapAndDirectEncodersAgree} is the durable assertion (the two
 * encoders must produce byte-identical output). {@link #logEncodeTimings} prints
 * ns/op for both so a real-device run under {@code atest
 * perfetto_trace_instrumentation_test} shows the numbers in logcat. The precise
 * host numbers come from {@code PerfettoEmitBenchmark} with
 * {@code -Dperfetto.bench.encodeAb=true}.
 */
@RunWith(AndroidJUnit4.class)
public class EncodeAbBenchmarkTest {
  private static final int[] SHAPES = {0, 1, 3, 8};
  private static final int WARMUP = 50_000;
  private static final int ITERS = 300_000;

  @Test
  public void allEncodersAgree() {
    String[] names = EncodeAbBodies.argNames();
    for (int n : SHAPES) {
      ProtoWriter heap = new ProtoWriter();
      EncodeAbBodies.buildHeapBody(heap, n, names);
      byte[] viaHeap = Arrays.copyOf(heap.buffer(), heap.position());

      DirectProtoWriter direct = new DirectProtoWriter();
      EncodeAbBodies.buildDirectBody(direct, n, names);
      assertThat(direct.toByteArray()).isEqualTo(viaHeap);

      UnsafeProtoWriter unsafe = new UnsafeProtoWriter();
      EncodeAbBodies.buildUnsafeBody(unsafe, n, names);
      assertThat(unsafe.toByteArray()).isEqualTo(viaHeap);
    }
  }

  @Test
  public void logEncodeTimings() {
    String[] names = EncodeAbBodies.argNames();
    boolean onArt = "Dalvik".equals(System.getProperty("java.vm.name"));
    System.out.println("=== encode A/B: heap byte[]+copy vs direct ByteBuffer vs Unsafe ===");
    System.out.println(onArt ? "  (Unsafe arm is real Unsafe)" : "  (Unsafe arm is a byte[] stub)");
    for (int n : SHAPES) {
      ProtoWriter heapWriter = new ProtoWriter();
      ByteBuffer heapTarget = ByteBuffer.allocateDirect(4096).order(ByteOrder.LITTLE_ENDIAN);
      Runnable heap =
          () -> {
            heapWriter.reset();
            EncodeAbBodies.buildHeapBody(heapWriter, n, names);
            heapTarget.clear();
            heapTarget.put(heapWriter.buffer(), 0, heapWriter.position());
          };

      DirectProtoWriter directWriter = new DirectProtoWriter();
      Runnable direct =
          () -> {
            directWriter.reset();
            EncodeAbBodies.buildDirectBody(directWriter, n, names);
          };

      UnsafeProtoWriter unsafeWriter = new UnsafeProtoWriter();
      Runnable unsafe =
          () -> {
            unsafeWriter.reset();
            EncodeAbBodies.buildUnsafeBody(unsafeWriter, n, names);
          };

      double heapNs = timeBestOf(heap, 3);
      double directNs = timeBestOf(direct, 3);
      double unsafeNs = timeBestOf(unsafe, 3);
      System.out.printf(
          "  %d args: heap=%.1f  direct=%.1f (%.2fx)  unsafe=%.1f (%.2fx) ns/op%n",
          n, heapNs, directNs, heapNs / directNs, unsafeNs, heapNs / unsafeNs);
    }
  }

  private static double timeBestOf(Runnable op, int trials) {
    for (int i = 0; i < WARMUP; i++) {
      op.run();
    }
    double best = Double.MAX_VALUE;
    for (int t = 0; t < trials; t++) {
      long start = System.nanoTime();
      for (int i = 0; i < ITERS; i++) {
        op.run();
      }
      best = Math.min(best, (double) (System.nanoTime() - start) / ITERS);
    }
    return best;
  }
}
