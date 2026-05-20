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

import java.lang.reflect.Field;
import java.util.Arrays;
import sun.misc.Unsafe;

/**
 * EXPERIMENTAL, TEST-ONLY (throwaway branch). The "real fix" arm of the
 * body-encoding A/B: encode straight into off-heap memory with
 * {@code Unsafe.putByte(address, value)} over a cached raw address plus our own
 * cursor and capacity check — no {@link java.nio.DirectByteBuffer} position /
 * limit / accessibility / read-only checks, and no copy A (the body is left at a
 * stable native address ready for the emit call).
 *
 * <p><b>Host vs device.</b> Real {@code Unsafe} is what we want to measure, but
 * its speed only matters where it ships: ART. So this class is split like the
 * SDK's {@code host_stubs}: the {@code ON_ART} flag is a compile-time-foldable
 * {@code static final}, so the JIT keeps exactly one arm and drops the other:
 * <ul>
 *   <li><b>Android (ART):</b> real {@code sun.misc.Unsafe} over an
 *       {@code allocateMemory} region. On arm64 {@code Unsafe.putByte} is the
 *       {@code GenUnsafePutAbsolute} intrinsic — a single {@code strb}. This is
 *       the path whose perf is the point; run it on a device.
 *   <li><b>Host (non-ART):</b> a plain {@code byte[]} stub, so the host build
 *       needs no real {@code Unsafe} and the host A/B still runs. The host
 *       "unsafe" row therefore reflects a {@code byte[]} stub, not real
 *       {@code Unsafe}; read the real number from a device run.
 * </ul>
 *
 * <p>Off-heap memory (ART arm) is reused and a few KB leaks for the lifetime of
 * the bench/test — fine for a throwaway comparison. Produces byte-identical
 * output to {@link dev.perfetto.sdk.ProtoWriter}. Not thread-safe.
 */
final class UnsafeProtoWriter {
  private static final boolean ON_ART = "Dalvik".equals(System.getProperty("java.vm.name"));
  private static final Unsafe U = ON_ART ? acquireUnsafe() : null;
  private static final int BYTE_ARRAY_BASE = ON_ART ? U.arrayBaseOffset(byte[].class) : 0;

  private static final int WIRE_TYPE_VARINT = 0;
  private static final int WIRE_TYPE_DELIMITED = 2;
  private static final int NESTED_LENGTH_FIELD_SIZE = 4;
  private static final int MAX_NESTING_DEPTH = 16;
  private static final int DEFAULT_BUFFER_SIZE = 512;

  private long base; // ART arm: off-heap address.
  private byte[] heap; // host stub arm: backing array.
  private int capacity;
  private int pos;
  private final int[] nestingStack = new int[MAX_NESTING_DEPTH];
  private int nestingDepth;

  UnsafeProtoWriter() {
    this(DEFAULT_BUFFER_SIZE);
  }

  UnsafeProtoWriter(int bufferSize) {
    capacity = bufferSize;
    if (ON_ART) {
      base = U.allocateMemory(bufferSize);
    } else {
      heap = new byte[bufferSize];
    }
  }

  void reset() {
    pos = 0;
    nestingDepth = 0;
  }

  int position() {
    return pos;
  }

  void writeVarInt(int fieldId, long value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_VARINT));
    writeRawVarInt(value);
  }

  void writeString(int fieldId, String value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_DELIMITED));
    int len = value.length();
    boolean ascii = true;
    for (int i = 0; i < len; i++) {
      if (value.charAt(i) > 0x7F) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      writeRawVarInt(len);
      ensureCapacity(len);
      for (int i = 0; i < len; i++) {
        put((byte) value.charAt(i));
      }
    } else {
      byte[] utf8 = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      writeRawVarInt(utf8.length);
      ensureCapacity(utf8.length);
      for (byte b : utf8) {
        put(b);
      }
    }
  }

  int beginNested(int fieldId) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_DELIMITED));
    ensureCapacity(NESTED_LENGTH_FIELD_SIZE);
    int bookmark = pos;
    pos += NESTED_LENGTH_FIELD_SIZE;
    nestingStack[nestingDepth++] = bookmark;
    return nestingDepth - 1;
  }

  void endNested(int token) {
    nestingDepth--;
    int bookmark = nestingStack[token];
    int size = pos - bookmark - NESTED_LENGTH_FIELD_SIZE;
    putAt(bookmark, (byte) ((size & 0x7F) | 0x80));
    putAt(bookmark + 1, (byte) (((size >> 7) & 0x7F) | 0x80));
    putAt(bookmark + 2, (byte) (((size >> 14) & 0x7F) | 0x80));
    putAt(bookmark + 3, (byte) ((size >> 21) & 0x7F));
  }

  /** Copies the encoded bytes out. Allocates; for verification only. */
  byte[] toByteArray() {
    if (ON_ART) {
      byte[] out = new byte[pos];
      U.copyMemory(null, base, out, BYTE_ARRAY_BASE, pos);
      return out;
    }
    return Arrays.copyOf(heap, pos);
  }

  // ON_ART is a static final, so the JIT folds these to one arm: a single
  // intrinsified Unsafe.putByte (a strb) on ART, or a byte[] store on host.
  private void put(byte b) {
    if (ON_ART) {
      U.putByte(base + pos, b);
    } else {
      heap[pos] = b;
    }
    pos++;
  }

  private void putAt(int at, byte b) {
    if (ON_ART) {
      U.putByte(base + at, b);
    } else {
      heap[at] = b;
    }
  }

  private static long makeTag(int fieldId, int wireType) {
    return ((long) fieldId << 3) | wireType;
  }

  private void writeRawVarInt(long value) {
    ensureCapacity(10);
    while ((value & ~0x7FL) != 0) {
      put((byte) ((value & 0x7F) | 0x80));
      value >>>= 7;
    }
    put((byte) value);
  }

  private void ensureCapacity(int needed) {
    if (pos + needed <= capacity) {
      return;
    }
    int newCap = Math.max(capacity * 2, pos + needed);
    if (ON_ART) {
      base = U.reallocateMemory(base, newCap);
    } else {
      heap = Arrays.copyOf(heap, newCap);
    }
    capacity = newCap;
  }

  private static Unsafe acquireUnsafe() {
    try {
      Field f = Unsafe.class.getDeclaredField("theUnsafe");
      f.setAccessible(true);
      return (Unsafe) f.get(null);
    } catch (ReflectiveOperationException e) {
      throw new ExceptionInInitializerError(e);
    }
  }
}
