// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Module-level loading / error state shared between the slim diff header
// (renders progress + filename + close) and the "Load baseline" button that
// lives in the Overview tab. Both components write through `triggerFileLoad`
// and read state via `getLoadState`.

import m from 'mithril';
import type {Raf} from '../../../public/raf';
import {BaselineLoadError, loadBaseline} from './loader';
import {addBaselineTrace, getActiveBaseline, setActiveBaseline} from './state';

interface LoadState {
  loading: boolean;
  progressBytes: number;
  progressTotal: number;
  error: string | null;
  /** Counter to make engine ids unique within the page. */
  nextId: number;
}

const state: LoadState = {
  loading: false,
  progressBytes: 0,
  progressTotal: 0,
  error: null,
  nextId: 1,
};

export interface LoadStateView {
  readonly loading: boolean;
  readonly progressPct: number;
  readonly error: string | null;
}

export function getLoadState(): LoadStateView {
  const pct =
    state.progressTotal > 0
      ? Math.round((state.progressBytes / state.progressTotal) * 100)
      : 0;
  return {loading: state.loading, progressPct: pct, error: state.error};
}

export function clearLoadError(): void {
  if (state.error !== null) {
    state.error = null;
    m.redraw();
  }
}

export async function triggerFileLoad(raf: Raf, file: File): Promise<void> {
  state.loading = true;
  state.progressBytes = 0;
  state.progressTotal = file.size;
  state.error = null;
  m.redraw();
  try {
    const result = await loadBaseline({
      file,
      raf,
      engineId: `heapdump-baseline-${state.nextId++}`,
      onProgress: (p) => {
        state.progressBytes = p.bytesRead;
        state.progressTotal = p.bytesTotal;
        m.redraw();
      },
    });
    const trace = addBaselineTrace(
      result.engine,
      result.filename,
      result.dumps,
    );
    // UX nicety: if the new trace contributes the only candidate dump in the
    // pool (single-dump trace and no prior baseline selection), auto-pick it
    // as the active baseline so diff renders immediately. Otherwise leave
    // selection to the user — they came here precisely because they need to
    // pick.
    if (getActiveBaseline() === null && trace.dumps.length === 1) {
      setActiveBaseline({trace, dump: trace.dumps[0]});
    }
  } catch (err) {
    if (err instanceof BaselineLoadError) {
      state.error = err.message;
    } else {
      state.error = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      console.error('Baseline load failed:', err);
    }
  } finally {
    state.loading = false;
    m.redraw();
  }
}
