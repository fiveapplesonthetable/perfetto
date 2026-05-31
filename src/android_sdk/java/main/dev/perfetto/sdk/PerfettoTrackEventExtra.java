/*
 * Copyright (C) 2024 The Android Open Source Project
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
import dalvik.annotation.optimization.FastNative;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Holds extras to be passed to Perfetto track events in {@link PerfettoTrace}.
 *
 * @hide
 */
final class PerfettoTrackEventExtra {
  private final long mPtr;

  PerfettoTrackEventExtra(PerfettoNativeMemoryCleaner memoryCleaner) {
    mPtr = native_init();
    memoryCleaner.registerNativeAllocation(this, mPtr, native_delete());
  }

  /** Returns the native pointer. */
  public long getPtr() {
    return mPtr;
  }

  /** Adds a pointer representing a track event parameter. */
  public void addPerfettoPointer(PerfettoPointer extra) {
    native_add_arg(mPtr, extra.getPtr());
  }

  /** Resets the track event extra. */
  public void reset() {
    native_clear_args(mPtr);
  }

  @CriticalNative
  private static native long native_init();

  @CriticalNative
  private static native long native_delete();

  @CriticalNative
  private static native void native_add_arg(long ptr, long extraPtr);

  @CriticalNative
  private static native void native_clear_args(long ptr);

  @FastNative
  public static native void native_emit(
      int type, long tag, String name, long ptr, long rawBodyPtr, byte[] body, int bodyLen);

  /** Represents a native pointer to a Perfetto C SDK struct. E.g. PerfettoTeHlExtra. */
  interface PerfettoPointer {
    /** Returns the perfetto struct native pointer. */
    long getPtr();
  }

  /**
   * A (possibly nested) chain of named tracks emitted via the HL {@code
   * NESTED_TRACKS} extra. Built once per {@link PerfettoTrack} (cached by the
   * builder) so the emit path stays allocation-free; the native side derives the
   * per-level uuids and emits a {@code TrackDescriptor} for each level once per
   * sequence. A flat named track is just a one-level chain, so this single
   * primitive subsumes the old single-named-track path.
   */
  static final class NestedTracks implements PerfettoPointer {
    private final long mPtr;
    private final long mExtraPtr;
    private final PerfettoTrack mSource;

    NestedTracks(PerfettoTrack track, PerfettoNativeMemoryCleaner memoryCleaner) {
      mPtr = native_init(track.mRootType, track.mTid, track.mNames, track.mIds,
          track.mIsNameStatic, track.mIsCounter);
      mExtraPtr = native_get_extra_ptr(mPtr);
      mSource = track;
      memoryCleaner.registerNativeAllocation(this, mPtr, native_delete());
    }

    @Override
    public long getPtr() {
      return mExtraPtr;
    }

    PerfettoTrack getSource() {
      return mSource;
    }

    @FastNative
    private static native long native_init(
        int rootType, long tid, String[] names, long[] ids, boolean[] isNameStatic,
        boolean[] isCounter);

    @CriticalNative
    private static native long native_delete();

    @CriticalNative
    private static native long native_get_extra_ptr(long ptr);
  }

  static final class Counter implements PerfettoPointer {
    private final long mPtr;
    private final long mExtraPtr;

    Counter(PerfettoNativeMemoryCleaner memoryCleaner) {
      mPtr = native_init();
      mExtraPtr = native_get_extra_ptr(mPtr);
      memoryCleaner.registerNativeAllocation(this, mPtr, native_delete());
    }

    @Override
    public long getPtr() {
      return mExtraPtr;
    }

    public void setValueInt64(long value) {
      native_set_value_int64(mPtr, value);
    }

    public void setValueDouble(double value) {
      native_set_value_double(mPtr, value);
    }

    @CriticalNative
    private static native long native_init();

    @CriticalNative
    private static native long native_delete();

    @CriticalNative
    private static native void native_set_value_int64(long ptr, long value);

    @CriticalNative
    private static native void native_set_value_double(long ptr, double value);

    @CriticalNative
    private static native long native_get_extra_ptr(long ptr);
  }

  /**
   * The extra that carries everything encoded on the Java side: the track_event
   * body (debug args, flows and plain proto fields, written via {@link
   * ProtoWriter}) spliced in as one raw proto field, plus any interned string
   * fields added via {@link #addInterned}. Reused across events; the body is
   * copied into native and emitted in a single {@code native_emit} crossing.
   */
  static final class RawBody implements PerfettoPointer {
    private final long mPtr;
    private final long mExtraPtr;

    RawBody(PerfettoNativeMemoryCleaner memoryCleaner) {
      mPtr = native_init();
      mExtraPtr = native_get_extra_ptr(mPtr);
      memoryCleaner.registerNativeAllocation(this, mPtr, native_delete());
    }

    @Override
    public long getPtr() {
      return mExtraPtr;
    }

    /**
     * Native RawBody pointer. The body bytes are copied into this object's
     * buffer inside the {@code native_emit} call (one JNI crossing for copy and
     * emit together), so there is no separate set-body crossing.
     */
    long bodyPtr() {
      return mPtr;
    }

    /**
     * Adds an interned string proto field that rides alongside the body and is
     * interned natively at emit time (its iid is per-sequence native state the
     * verbatim body can't carry).
     */
    void addInterned(long id, String val, long internedTypeId) {
      native_add_interned(mPtr, id, val, internedTypeId);
    }

    @CriticalNative
    private static native long native_init();

    @FastNative
    private static native void native_add_interned(
        long ptr, long id, String val, long internedTypeId);

    @CriticalNative
    private static native long native_delete();

    @CriticalNative
    private static native long native_get_extra_ptr(long ptr);
  }

}
