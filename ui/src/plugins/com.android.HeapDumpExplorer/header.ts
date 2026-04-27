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

// Slim status strip rendered above the Heapdump Explorer tabs.
//
// Visibility:
//   - No baseline + not loading + no error  → renders nothing.
//                                              The "Load baseline" button
//                                              lives in the Overview tab.
//   - Loading                                → progress callout.
//   - Error                                  → dismissible danger callout.
//   - Baseline loaded                        → status callout with filename,
//                                              SegmentedButtons mode toggle,
//                                              and a close button.
//
// Built from Perfetto widgets only — no bespoke chrome.

import m from 'mithril';
import {Button, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {SegmentedButtons} from '../../widgets/segmented_buttons';
import type {DiffMode} from './baseline/state';
import {
  dispose as disposeBaseline,
  getMode,
  getSession,
  setMode,
} from './baseline/state';
import {clearLoadError, getLoadState} from './baseline/load_action';

const MODES: ReadonlyArray<{key: DiffMode; label: string}> = [
  {key: 'diff', label: 'Diff'},
  {key: 'current', label: 'Current'},
  {key: 'baseline', label: 'Baseline'},
];

export function HeapDumpDiffHeader(): m.Component {
  return {
    view() {
      const session = getSession();
      const {loading, progressPct, error} = getLoadState();

      // Idle + no baseline + no error → render nothing. The "Load baseline"
      // button lives in the Overview tab.
      if (!session && !loading && !error) return null;

      if (loading) {
        return m(
          Callout,
          {icon: 'hourglass_empty', intent: Intent.None},
          `Loading baseline trace… ${progressPct}%`,
        );
      }

      if (error && !session) {
        return m(
          Callout,
          {
            'icon': 'error',
            'intent': Intent.Danger,
            'dismissible': true,
            'onDismiss': () => clearLoadError(),
            'role': 'alert',
            'aria-live': 'assertive',
          },
          error,
        );
      }

      // session !== null
      return m(
        Callout,
        {icon: 'difference', intent: Intent.None},
        m(
          'div',
          {class: 'ah-baseline-status'},
          m(
            'span',
            {class: 'ah-baseline-status__filename', title: session!.filename},
            'Baseline: ',
            m(
              'span',
              {class: 'ah-mono'},
              truncateFilename(session!.filename),
            ),
          ),
          m(SegmentedButtons, {
            'options': MODES.map((m) => ({label: m.label})),
            'selectedOption': MODES.findIndex((m) => m.key === getMode()),
            'onOptionSelected': (i) => setMode(MODES[i].key),
            'aria-label': 'Diff mode',
          }),
          m(Button, {
            'icon': 'close',
            'variant': ButtonVariant.Minimal,
            'compact': true,
            'title': 'Close baseline',
            'aria-label': 'Close baseline',
            'onclick': () => {
              disposeBaseline();
              clearLoadError();
            },
          }),
        ),
      );
    },
  };
}

function truncateFilename(name: string): string {
  if (name.length <= 48) return name;
  return name.slice(0, 22) + '…' + name.slice(-22);
}
