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

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * EXPERIMENTAL, TEST-ONLY. Not part of the shipped SDK; lives on a throwaway
 * branch to A/B one design decision and is meant to be deleted.
 *
 * <p>This is the "encode straight into the off-heap buffer" alternative to the
 * production {@link dev.perfetto.sdk.ProtoWriter}. The production writer encodes
 * into a heap {@code byte[]} and then bulk-{@code memcpy}s the body into a direct
 * {@link ByteBuffer} (copy A) so a {@code @CriticalNative} call can read it at a
 * stable address. This variant skips the heap {@code byte[]} and writes each
 * field directly into the direct buffer, removing copy A at the cost of every
 * per-field write going through a bounds-checked {@code ByteBuffer} put instead of
 * a JIT-optimized array store.
 *
 * <p>It mirrors the subset of the {@code ProtoWriter} API the benchmark body uses
 * and produces byte-identical output (asserted in the benchmark), so the two are
 * a faithful apples-to-apples comparison. See {@link PerfettoEmitBenchmark} for
 * the measured numbers and the writeup.
 *
 * <p>Little-endian to match the native side. Not thread-safe.
 */
final class DirectProtoWriter {
  private static final int WIRE_TYPE_VARINT = 0;
  private static final int WIRE_TYPE_FIXED64 = 1;
  private static final int WIRE_TYPE_DELIMITED = 2;
  private static final int WIRE_TYPE_FIXED32 = 5;

  private static final int NESTED_LENGTH_FIELD_SIZE = 4;
  private static final int MAX_NESTING_DEPTH = 16;
  private static final int DEFAULT_BUFFER_SIZE = 512;

  private ByteBuffer mBuf;
  private final int[] mNestingStack = new int[MAX_NESTING_DEPTH];
  private int mNestingDepth;

  DirectProtoWriter() {
    this(DEFAULT_BUFFER_SIZE);
  }

  DirectProtoWriter(int bufferSize) {
    mBuf = ByteBuffer.allocateDirect(bufferSize).order(ByteOrder.LITTLE_ENDIAN);
  }

  /** Resets the write position so the buffer can be reused. No allocation. */
  void reset() {
    mBuf.clear();
    mNestingDepth = 0;
  }

  /** Number of bytes written so far. */
  int position() {
    return mBuf.position();
  }

  /** The backing direct buffer. Valid data spans {@code [0, position())}. */
  ByteBuffer buffer() {
    return mBuf;
  }

  void writeVarInt(int fieldId, long value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_VARINT));
    writeRawVarInt(value);
  }

  void writeSInt(int fieldId, long value) {
    writeVarInt(fieldId, (value << 1) ^ (value >> 63));
  }

  void writeBool(int fieldId, boolean value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_VARINT));
    ensureCapacity(1);
    mBuf.put((byte) (value ? 1 : 0));
  }

  void writeFixed64(int fieldId, long value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_FIXED64));
    ensureCapacity(8);
    mBuf.putLong(value);
  }

  void writeFixed32(int fieldId, int value) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_FIXED32));
    ensureCapacity(4);
    mBuf.putInt(value);
  }

  void writeDouble(int fieldId, double value) {
    writeFixed64(fieldId, Double.doubleToRawLongBits(value));
  }

  void writeFloat(int fieldId, float value) {
    writeFixed32(fieldId, Float.floatToRawIntBits(value));
  }

  /**
   * Writes a string field. ASCII fast path (the common case for event names,
   * categories and arg keys); UTF-8 fallback for the rest.
   */
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
        mBuf.put((byte) value.charAt(i));
      }
    } else {
      // Rare on this path; the benchmark uses ASCII. Correctness over speed.
      byte[] utf8 = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      writeRawVarInt(utf8.length);
      ensureCapacity(utf8.length);
      mBuf.put(utf8);
    }
  }

  void writeBytes(int fieldId, byte[] value, int offset, int length) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_DELIMITED));
    writeRawVarInt(length);
    ensureCapacity(length);
    mBuf.put(value, offset, length);
  }

  int beginNested(int fieldId) {
    writeRawVarInt(makeTag(fieldId, WIRE_TYPE_DELIMITED));
    ensureCapacity(NESTED_LENGTH_FIELD_SIZE);
    int bookmark = mBuf.position();
    mBuf.position(bookmark + NESTED_LENGTH_FIELD_SIZE);
    mNestingStack[mNestingDepth++] = bookmark;
    return mNestingDepth - 1;
  }

  void endNested(int token) {
    mNestingDepth--;
    int bookmark = mNestingStack[token];
    int size = mBuf.position() - bookmark - NESTED_LENGTH_FIELD_SIZE;
    // Absolute puts: backfill the reserved 4-byte redundant varint without
    // disturbing the write cursor.
    mBuf.put(bookmark, (byte) ((size & 0x7F) | 0x80));
    mBuf.put(bookmark + 1, (byte) (((size >> 7) & 0x7F) | 0x80));
    mBuf.put(bookmark + 2, (byte) (((size >> 14) & 0x7F) | 0x80));
    mBuf.put(bookmark + 3, (byte) ((size >> 21) & 0x7F));
  }

  void appendRawBytes(byte[] data, int offset, int length) {
    ensureCapacity(length);
    mBuf.put(data, offset, length);
  }

  /** Copies the encoded bytes out. Allocates; for verification only. */
  byte[] toByteArray() {
    int pos = mBuf.position();
    byte[] out = new byte[pos];
    mBuf.position(0);
    mBuf.get(out);
    mBuf.position(pos);
    return out;
  }

  private static long makeTag(int fieldId, int wireType) {
    return ((long) fieldId << 3) | wireType;
  }

  private void writeRawVarInt(long value) {
    ensureCapacity(10);
    while ((value & ~0x7FL) != 0) {
      mBuf.put((byte) ((value & 0x7F) | 0x80));
      value >>>= 7;
    }
    mBuf.put((byte) value);
  }

  private void ensureCapacity(int needed) {
    int pos = mBuf.position();
    if (pos + needed <= mBuf.capacity()) {
      return;
    }
    int newCap = Math.max(mBuf.capacity() * 2, pos + needed);
    ByteBuffer nb = ByteBuffer.allocateDirect(newCap).order(ByteOrder.LITTLE_ENDIAN);
    mBuf.flip();
    nb.put(mBuf);
    mBuf = nb;
  }
}
