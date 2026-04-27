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

// "Load baseline trace" button that lives in the Overview tab when no
// baseline is loaded. Wraps a hidden <input type=file> behind a Perfetto
// Button so the visual treatment matches the rest of the UI.

import m from 'mithril';
import {Button, ButtonVariant} from '../../../widgets/button';
import {Intent} from '../../../widgets/common';
import type {Raf} from '../../../public/raf';
import {getLoadState, triggerFileLoad} from './load_action';

const FILE_ACCEPT =
  '.pftrace,.hprof,.perfetto-trace,.pb,.gz,application/octet-stream';

export interface LoadBaselineButtonAttrs {
  readonly raf: Raf;
  /** Visual variant. Filled (primary action) by default. */
  readonly variant?: ButtonVariant;
  readonly intent?: Intent;
  readonly label?: string;
  readonly icon?: string;
}

export function LoadBaselineButton(): m.Component<LoadBaselineButtonAttrs> {
  let inputEl: HTMLInputElement | null = null;
  return {
    view(vnode) {
      const {raf, variant, intent, label, icon} = vnode.attrs;
      const {loading} = getLoadState();
      return [
        m('input', {
          "type": 'file',
          "accept": FILE_ACCEPT,
          "style": 'display:none',
          'aria-hidden': 'true',
          "oncreate": (v) => {
            inputEl = v.dom as HTMLInputElement;
          },
          "onchange": async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            await triggerFileLoad(raf, file);
            if (inputEl) inputEl.value = '';
          },
        }),
        m(Button, {
          label: label ?? 'Load baseline trace',
          icon: icon ?? 'upload_file',
          intent: intent ?? Intent.Primary,
          variant: variant ?? ButtonVariant.Filled,
          loading,
          disabled: loading,
          onclick: () => inputEl?.click(),
        }),
      ];
    },
  };
}
