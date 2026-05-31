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

package dev.perfetto.sdk;

import dalvik.annotation.optimization.CriticalNative;
import dev.perfetto.sdk.PerfettoTrace.Category;

import java.nio.ByteBuffer;

/**
 * Java-side track event emit path, built on the public Low Level track event
 * ABI.
 *
 * <p>Where {@link PerfettoTrackEventExtra} builds an event out of native "extra"
 * structs through the High Level ABI, this drives the LL ABI: a single native
 * call walks the active data source instances and serializes the {@code
 * TrackEvent} with protozero. Category / event-name interning, incremental-state
 * resets and per-instance fan-out stay native (the LL ABI owns them).
 *
 * <p>The "body" -- the variable part of a {@code TrackEvent} (debug annotations,
 * and later flows / proto fields) -- is encoded on the Java side into a reused
 * {@link ProtoWriter} and appended verbatim into the {@code track_event}
 * submessage natively. The hot path is allocation-free: the event name is
 * converted with the thread-local {@code StringBuffer} (no Java-heap object, no
 * native malloc), and the body buffer is reused across events.
 *
 * @hide
 */
public final class PerfettoEvent {
  // Keep in sync with C++ (PerfettoTeType).
  static final int TYPE_SLICE_BEGIN = 1;
  static final int TYPE_SLICE_END = 2;
  static final int TYPE_INSTANT = 3;
  static final int TYPE_COUNTER = 4;

  // TrackEvent field numbers.
  private static final int TE_DEBUG_ANNOTATIONS = 4;
  private static final int TE_COUNTER_VALUE = 30;
  private static final int TE_DOUBLE_COUNTER_VALUE = 44;
  private static final int TE_FLOW_IDS = 47;
  private static final int TE_TERMINATING_FLOW_IDS = 48;

  // DebugAnnotation field numbers.
  private static final int DA_BOOL_VALUE = 2;
  private static final int DA_INT_VALUE = 4;
  private static final int DA_DOUBLE_VALUE = 5;
  private static final int DA_STRING_VALUE = 6;
  private static final int DA_NAME = 10;

  // Process track uuid, cached on first use; flows are xor-folded with it,
  // matching PerfettoTeProcessScopedFlow in the C SDK.
  private static volatile long sProcessTrackUuid;
  private static volatile boolean sProcessTrackUuidValid;

  private PerfettoEvent() {}

  private static long processTrackUuid() {
    if (!sProcessTrackUuidValid) {
      sProcessTrackUuid = PerfettoTrace.getProcessTrackUuid();
      sProcessTrackUuidValid = true;
    }
    return sProcessTrackUuid;
  }

  // All encode methods take the caller's ProtoWriter `b` (owned by the thread-
  // local PerfettoTrackEventBuilder) so the hot path does no ThreadLocal lookup.

  /** Appends an int64 debug annotation to the body. */
  static void addArg(ProtoWriter b, String name, long value) {
    int da = b.beginNested(TE_DEBUG_ANNOTATIONS);
    b.writeString(DA_NAME, name);
    b.writeVarInt(DA_INT_VALUE, value);
    b.endNested(da);
  }

  /** Appends a bool debug annotation to the body. */
  static void addArg(ProtoWriter b, String name, boolean value) {
    int da = b.beginNested(TE_DEBUG_ANNOTATIONS);
    b.writeString(DA_NAME, name);
    b.writeBool(DA_BOOL_VALUE, value);
    b.endNested(da);
  }

  /** Appends a double debug annotation to the body. */
  static void addArg(ProtoWriter b, String name, double value) {
    int da = b.beginNested(TE_DEBUG_ANNOTATIONS);
    b.writeString(DA_NAME, name);
    b.writeDouble(DA_DOUBLE_VALUE, value);
    b.endNested(da);
  }

  /** Appends a string debug annotation to the body. */
  static void addArg(ProtoWriter b, String name, String value) {
    int da = b.beginNested(TE_DEBUG_ANNOTATIONS);
    b.writeString(DA_NAME, name);
    b.writeString(DA_STRING_VALUE, value);
    b.endNested(da);
  }

  /** Appends a (process-scoped) flow id to the body. */
  static void addFlow(ProtoWriter b, long id) {
    b.writeFixed64(TE_FLOW_IDS, id ^ processTrackUuid());
  }

  /** Appends a (process-scoped) terminating flow id to the body. */
  static void addTerminatingFlow(ProtoWriter b, long id) {
    b.writeFixed64(TE_TERMINATING_FLOW_IDS, id ^ processTrackUuid());
  }

  /** Sets a long counter value on the body. */
  static void setCounter(ProtoWriter b, long value) {
    b.writeVarInt(TE_COUNTER_VALUE, value);
  }

  /** Sets a double counter value on the body. */
  static void setCounter(ProtoWriter b, double value) {
    b.writeDouble(TE_DOUBLE_COUNTER_VALUE, value);
  }

  /** Appends a varint proto field to the body (for beginProto/addField). */
  static void protoVarInt(ProtoWriter b, int fieldId, long value) {
    b.writeVarInt(fieldId, value);
  }

  /** Appends a double proto field to the body. */
  static void protoDouble(ProtoWriter b, int fieldId, double value) {
    b.writeDouble(fieldId, value);
  }

  /** Appends a string proto field to the body. */
  static void protoString(ProtoWriter b, int fieldId, String value) {
    b.writeString(fieldId, value);
  }

  /** Begins a nested proto message in the body; returns the token for endNested. */
  static int protoBeginNested(ProtoWriter b, int fieldId) {
    return b.beginNested(fieldId);
  }

  /** Ends a nested proto message started with {@link #protoBeginNested}. */
  static void protoEndNested(ProtoWriter b, int token) {
    b.endNested(token);
  }

}
