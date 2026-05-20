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

/**
 * An immutable, reusable handle to a (possibly nested) named track.
 *
 * <p>Build a track once — typically a {@code static final} — and pass it to
 * {@link PerfettoTrackEventBuilder#usingTrack}. A track is rooted at the process,
 * the current thread, or the global scope, and can be nested arbitrarily deep with
 * {@link #child}:
 *
 * <pre>
 *   static final PerfettoTrack RENDER = PerfettoTrack.process("Render");
 *   static final PerfettoTrack GPU = RENDER.child("GPU");
 *   ...
 *   PerfettoTrace.instant(CAT, "frame").usingTrack(GPU).emit();
 * </pre>
 *
 * <p>Emitting on {@code GPU} emits the {@code TrackDescriptor}s for the whole
 * chain (Render under the process, GPU under Render) once per sequence, matching
 * the C SDK's nested-track behaviour. The track uuid is derived natively exactly
 * as the C SDK derives it.
 *
 * <p>This is the nesting-only shape supported by the high-level ABI; sibling
 * ordering, counter units and similar are intentionally not exposed here.
 */
public final class PerfettoTrack {
  // Root scope of the chain. Kept in sync with the native mapping in
  // dev_perfetto_sdk_PerfettoTrackEventExtra.cc.
  static final int ROOT_GLOBAL = 0;
  static final int ROOT_PROCESS = 1;
  static final int ROOT_THREAD = 2;

  final int mRootType;
  // Names and ids of the chain, outermost (closest to the root) first.
  final String[] mNames;
  final long[] mIds;
  final int mCacheKey;

  private PerfettoTrack(int rootType, String[] names, long[] ids) {
    mRootType = rootType;
    mNames = names;
    mIds = ids;
    mCacheKey = computeCacheKey(rootType, names, ids);
  }

  /** A track named {@code name} rooted at the process track. */
  public static PerfettoTrack process(@CompileTimeConstant String name) {
    return new PerfettoTrack(ROOT_PROCESS, new String[] {name}, new long[] {0});
  }

  /** A track named {@code name} rooted at the calling thread's track. */
  public static PerfettoTrack thread(@CompileTimeConstant String name) {
    return new PerfettoTrack(ROOT_THREAD, new String[] {name}, new long[] {0});
  }

  /** A track named {@code name} rooted at the global scope. */
  public static PerfettoTrack global(@CompileTimeConstant String name) {
    return new PerfettoTrack(ROOT_GLOBAL, new String[] {name}, new long[] {0});
  }

  /** A child track named {@code name} nested under this one. */
  public PerfettoTrack child(@CompileTimeConstant String name) {
    return child(0, name);
  }

  /**
   * A child track named {@code name} nested under this one. {@code id} further
   * disambiguates the track from same-named siblings.
   */
  public PerfettoTrack child(long id, @CompileTimeConstant String name) {
    int n = mNames.length;
    String[] names = new String[n + 1];
    long[] ids = new long[n + 1];
    System.arraycopy(mNames, 0, names, 0, n);
    System.arraycopy(mIds, 0, ids, 0, n);
    names[n] = name;
    ids[n] = id;
    return new PerfettoTrack(mRootType, names, ids);
  }

  private static int computeCacheKey(int rootType, String[] names, long[] ids) {
    int h = rootType;
    for (String name : names) {
      h = 31 * h + name.hashCode();
    }
    for (long id : ids) {
      h = 31 * h + (int) (id ^ (id >>> 32));
    }
    return h;
  }
}
