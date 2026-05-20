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

import dev.perfetto.sdk.ProtoWriter;

/**
 * EXPERIMENTAL, TEST-ONLY (throwaway branch). Shared body builders for the
 * encode A/B, used by both the host {@link PerfettoEmitBenchmark} and the
 * device-runnable {@link EncodeAbBenchmarkTest}. Touches only {@link ProtoWriter}
 * and {@link DirectProtoWriter}, so it is safe in the Android instrumentation APK
 * (unlike the host-only benchmark, which uses {@code com.sun.management}).
 *
 * <p>Both builders emit the same N {@code DebugAnnotation} sub-messages, so the
 * two encoders produce byte-identical output and the comparison is fair.
 */
final class EncodeAbBodies {
  private static final int DA_DEBUG_ANNOTATIONS = 4; // TrackEvent.debug_annotations
  private static final int DA_NAME = 10; // DebugAnnotation.name
  private static final int DA_INT_VALUE = 6; // DebugAnnotation.int_value

  private EncodeAbBodies() {}

  /** A fixed pool of distinct arg names so building bodies allocates nothing. */
  static String[] argNames() {
    String[] names = new String[64];
    for (int i = 0; i < names.length; i++) {
      names[i] = "arg_" + i;
    }
    return names;
  }

  static void buildHeapBody(ProtoWriter w, int nargs, String[] names) {
    for (int i = 0; i < nargs; i++) {
      int t = w.beginNested(DA_DEBUG_ANNOTATIONS);
      w.writeString(DA_NAME, names[i]);
      w.writeVarInt(DA_INT_VALUE, 42L + i);
      w.endNested(t);
    }
  }

  static void buildDirectBody(DirectProtoWriter w, int nargs, String[] names) {
    for (int i = 0; i < nargs; i++) {
      int t = w.beginNested(DA_DEBUG_ANNOTATIONS);
      w.writeString(DA_NAME, names[i]);
      w.writeVarInt(DA_INT_VALUE, 42L + i);
      w.endNested(t);
    }
  }

  static void buildUnsafeBody(UnsafeProtoWriter w, int nargs, String[] names) {
    for (int i = 0; i < nargs; i++) {
      int t = w.beginNested(DA_DEBUG_ANNOTATIONS);
      w.writeString(DA_NAME, names[i]);
      w.writeVarInt(DA_INT_VALUE, 42L + i);
      w.endNested(t);
    }
  }
}
