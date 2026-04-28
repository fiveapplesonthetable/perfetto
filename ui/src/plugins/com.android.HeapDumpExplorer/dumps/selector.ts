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

import m from 'mithril';
import {Trace} from '../../../public/trace';
import {Time} from '../../../base/time';
import {Button, ButtonVariant} from '../../../widgets/button';
import {MenuItem, PopupMenu} from '../../../widgets/menu';
import {formatDuration} from '../../../components/time_utils';
import {getActive, getDumps, HeapDump, setActive} from './state';

interface DumpSelectorAttrs {
  readonly trace: Trace;
}

/**
 * Header strip selector that disambiguates which heap dump every aggregating
 * query in the page filters on. Renders nothing when the trace contains a
 * single dump — multi-dump traces are rare, and showing the selector in the
 * common case would just be visual noise.
 */
export class DumpSelector implements m.ClassComponent<DumpSelectorAttrs> {
  view({attrs}: m.Vnode<DumpSelectorAttrs>): m.Children {
    const dumps = getDumps();
    const active = getActive();
    if (dumps.length <= 1 || active === null) return null;

    return m(
      'div',
      {class: 'ah-dump-selector'},
      m('span', {class: 'ah-dump-selector__label'}, 'Heap dump:'),
      m(
        PopupMenu,
        {
          trigger: m(Button, {
            label: triggerLabel(active),
            icon: 'memory',
            rightIcon: 'arrow_drop_down',
            variant: ButtonVariant.Outlined,
            compact: true,
          }),
        },
        dumps.map((d) =>
          m(MenuItem, {
            label: itemLabel(d, attrs.trace),
            active: d === active,
            onclick: () => setActive(d),
          }),
        ),
      ),
    );
  }
}

function processLabel(d: HeapDump): string {
  return d.processName !== null
    ? `${d.processName} (pid ${d.pid})`
    : `pid ${d.pid}`;
}

function triggerLabel(d: HeapDump): string {
  return processLabel(d);
}

function itemLabel(d: HeapDump, trace: Trace): string {
  const offset = Time.diff(Time.fromRaw(d.ts), trace.traceInfo.start);
  return `${processLabel(d)} — ${formatDuration(trace, offset)}`;
}
