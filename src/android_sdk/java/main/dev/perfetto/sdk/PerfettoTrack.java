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

import com.google.errorprone.annotations.CompileTimeConstant;

import dev.perfetto.sdk.PerfettoTrackEventExtra.NestedTracks;

/**
 * An immutable, reusable handle to a (possibly nested) track.
 *
 * <p>Build a track once — typically a {@code static final} — and pass it to
 * {@link PerfettoTrackEventBuilder#usingTrack}. A track is rooted at the process,
 * the current thread, or the global scope, can be nested arbitrarily deep with
 * {@link #child}, and a leaf may be a counter ({@link #childCounter}):
 *
 * <pre>
 *   static final PerfettoTrack RENDER = PerfettoTrack.process("Render");
 *   static final PerfettoTrack GPU = RENDER.child("GPU");
 *   ...
 *   PerfettoTrace.instant(CAT, "frame").usingTrack(GPU).emit();
 * </pre>
 *
 * <p>Emitting on {@code GPU} emits the {@code TrackDescriptor}s for the whole
 * chain (Render under the process, GPU under Render) once per sequence; each uuid
 * is derived natively exactly as the C SDK derives it.
 *
 * <p>This is the single track primitive: the flat {@code usingProcessNamedTrack} /
 * {@code usingCounterTrack} builder helpers are sugar over a one-level
 * {@code PerfettoTrack}. Its names are compile-time constants, so a handle is held
 * in a {@code static final} field like a {@link PerfettoTrace.Category} and owns
 * its native track for life (built once, reused, freed on GC).
 */
public final class PerfettoTrack {
  // Root scope of the chain. Mirrors RootType in tracing_sdk.h.
  static final int ROOT_GLOBAL = 0;
  static final int ROOT_PROCESS = 1;
  static final int ROOT_THREAD = 2;

  // Default per-level id: no disambiguation between same-named sibling tracks.
  private static final long DEFAULT_ID = 0;

  final int mRootType;
  // The thread id the chain is rooted at, for ROOT_THREAD only. 0 means the
  // emitting thread (the common case, and the only shape the public factories
  // produce). Set explicitly only by the thread-scoped flat helper.
  final long mTid;
  // Names, ids, name-static flags and counter flags of the chain, outermost
  // (closest to the root) first. All four are parallel and the same length. A
  // counter leaf (mIsCounter[i] == true) is emitted with an empty
  // CounterDescriptor and a counter-magic uuid; only a leaf is ever a counter.
  final String[] mNames;
  final long[] mIds;
  final boolean[] mIsNameStatic;
  final boolean[] mIsCounter;

  // The handle's native nested-tracks extra, built lazily on first use and held
  // for the handle's lifetime. Freed by the cleaner when the handle is collected.
  private volatile NestedTracks mNested;

  // Frees a handle's native track when the handle is collected. SystemCleaner
  // needs no native lib, so it is safe to hold statically.
  private static final PerfettoNativeMemoryCleaner sCleaner =
      new PerfettoNativeMemoryCleaner();

  private PerfettoTrack(
      int rootType,
      long tid,
      String[] names,
      long[] ids,
      boolean[] isNameStatic,
      boolean[] isCounter) {
    mRootType = rootType;
    mTid = tid;
    mNames = names;
    mIds = ids;
    mIsNameStatic = isNameStatic;
    mIsCounter = isCounter;
  }

  /**
   * The handle's native nested-tracks extra, built once and reused.
   * Package-private; used by {@link PerfettoTrackEventBuilder#usingTrack}.
   *
   * <p>Lock-free lazy init: concurrent first callers may each build an equivalent
   * {@code NestedTracks}, but they are read-only and content-identical (same uuid
   * and descriptor, deduped per-sequence natively), so only one need survive. The
   * {@code volatile} field publishes the winner; the rest are freed by the cleaner.
   */
  NestedTracks nestedTracks() {
    NestedTracks n = mNested;
    if (n == null) {
      n = new NestedTracks(this, sCleaner);
      mNested = n;
    }
    return n;
  }

  /** A track named {@code name} rooted at the process track. */
  public static PerfettoTrack process(@CompileTimeConstant String name) {
    return rooted(ROOT_PROCESS, 0, name);
  }

  /** A track named {@code name} rooted at the calling thread's track. */
  public static PerfettoTrack thread(@CompileTimeConstant String name) {
    return rooted(ROOT_THREAD, 0, name);
  }

  /** A track named {@code name} rooted at the global scope. */
  public static PerfettoTrack global(@CompileTimeConstant String name) {
    return rooted(ROOT_GLOBAL, 0, name);
  }

  /** A counter track named {@code name} rooted at the process track. */
  public static PerfettoTrack processCounter(@CompileTimeConstant String name) {
    return rootedCounter(ROOT_PROCESS, 0, name);
  }

  /** A counter track named {@code name} rooted at the calling thread's track. */
  public static PerfettoTrack threadCounter(@CompileTimeConstant String name) {
    return rootedCounter(ROOT_THREAD, 0, name);
  }

  /** A child track named {@code name} nested under this one. */
  public PerfettoTrack child(@CompileTimeConstant String name) {
    return child(DEFAULT_ID, name);
  }

  /**
   * A child track named {@code name} nested under this one. {@code id} further
   * disambiguates the track from same-named siblings.
   */
  public PerfettoTrack child(long id, @CompileTimeConstant String name) {
    return appendLevel(id, name, /* isNameStatic= */ true, /* isCounter= */ false);
  }

  /**
   * A counter track named {@code name} nested under this one. A counter leaf
   * carries the counter value set via {@link
   * PerfettoTrackEventBuilder#setCounter}; its uuid is derived with the counter
   * magic and its descriptor carries an (empty) CounterDescriptor.
   */
  public PerfettoTrack childCounter(@CompileTimeConstant String name) {
    return appendLevel(DEFAULT_ID, name, /* isNameStatic= */ true, /* isCounter= */ true);
  }

  // --- Internal helpers for the flat named/counter-track builder sugar, which
  // makes those helpers a one-level PerfettoTrack. They take the leaf id and
  // name-static flag the public API doesn't, and (for the thread helper) an
  // explicit tid. The sugar builds a fresh handle per emit, so it looks up the
  // builder's content cache from scalar args (flatCacheKey/isFlat) and only
  // allocates a handle on a miss. ---

  /** A one-level (flat) track. Built only on a flat-sugar cache miss. */
  static PerfettoTrack flat(
      int rootType, long tid, String name, long id, boolean isNameStatic, boolean isCounter) {
    return new PerfettoTrack(
        rootType, tid, new String[] {name}, new long[] {id},
        new boolean[] {isNameStatic}, new boolean[] {isCounter});
  }

  /** The content cache key for a one-level track, computed without a handle. */
  static int flatCacheKey(
      int rootType, long tid, String name, long id, boolean isNameStatic, boolean isCounter) {
    int h = rootType;
    h = 31 * h + (int) (tid ^ (tid >>> 32));
    h = 31 * h + name.hashCode();
    h = 31 * h + (int) (id ^ (id >>> 32));
    h = 31 * h + (isNameStatic ? 1 : 0);
    h = 31 * h + (isCounter ? 1 : 0);
    return h;
  }

  /** True if this is exactly the given one-level track (no allocation). */
  boolean isFlat(
      int rootType, long tid, String name, long id, boolean isNameStatic, boolean isCounter) {
    return mNames.length == 1
        && mRootType == rootType
        && mTid == tid
        && mIds[0] == id
        && mIsNameStatic[0] == isNameStatic
        && mIsCounter[0] == isCounter
        && mNames[0].equals(name);
  }

  private static PerfettoTrack rooted(int rootType, long tid, String name) {
    return new PerfettoTrack(
        rootType, tid, new String[] {name}, new long[] {DEFAULT_ID}, new boolean[] {true},
        new boolean[] {false});
  }

  private static PerfettoTrack rootedCounter(int rootType, long tid, String name) {
    return new PerfettoTrack(
        rootType, tid, new String[] {name}, new long[] {DEFAULT_ID}, new boolean[] {true},
        new boolean[] {true});
  }

  private PerfettoTrack appendLevel(
      long id, String name, boolean isNameStatic, boolean isCounter) {
    int n = mNames.length;
    String[] names = new String[n + 1];
    long[] ids = new long[n + 1];
    boolean[] staticFlags = new boolean[n + 1];
    boolean[] counterFlags = new boolean[n + 1];
    System.arraycopy(mNames, 0, names, 0, n);
    System.arraycopy(mIds, 0, ids, 0, n);
    System.arraycopy(mIsNameStatic, 0, staticFlags, 0, n);
    System.arraycopy(mIsCounter, 0, counterFlags, 0, n);
    names[n] = name;
    ids[n] = id;
    staticFlags[n] = isNameStatic;
    counterFlags[n] = isCounter;
    return new PerfettoTrack(mRootType, mTid, names, ids, staticFlags, counterFlags);
  }
}
