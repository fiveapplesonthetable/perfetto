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

// Inline baseline-pool controls rendered into the top bar.
//
// Conceptually one component, but it returns just inline content (label +
// popup + mode toggle + clear/dispose buttons + a hidden file input) so the
// parent top bar can lay it out next to the primary dump selector in a
// single row. We only render anything when there is something for the user
// to act on:
//   - a baseline trace is in flight (loading), or
//   - a load failed and the error needs to be shown, or
//   - one or more baseline traces are pooled (whether or not one is active).
//
// In particular, when no baseline has ever been added we render nothing
// here — the entry point ("Diff against another trace") lives inside the
// Overview tab in that case. That keeps the top bar's vertical space free
// in the common single-trace, no-diff workflow.

import m from 'mithril';
import {Trace} from '../../public/trace';
import {Button, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {SegmentedButtons} from '../../widgets/segmented_buttons';
import {MenuDivider, MenuItem, PopupMenu} from '../../widgets/menu';
import {Time} from '../../base/time';
import {formatDuration} from '../../components/time_utils';
import type {DiffMode, BaselineDumpRef, BaselineTrace} from './baseline/state';
import {
  clearActiveBaseline,
  dispose as disposeBaseline,
  getActiveBaseline,
  getBaselineTraces,
  getMode,
  removeBaselineTrace,
  setActiveBaseline,
  setMode,
} from './baseline/state';
import {
  clearLoadError,
  getLoadState,
  triggerFileLoad,
} from './baseline/load_action';
import type {HeapDump} from './dumps/state';

const MODES: ReadonlyArray<{key: DiffMode; label: string}> = [
  {key: 'diff', label: 'Diff'},
  {key: 'current', label: 'Current'},
  {key: 'baseline', label: 'Baseline'},
];

const FILE_ACCEPT =
  '.pftrace,.hprof,.perfetto-trace,.pb,.gz,application/octet-stream';

/**
 * True when the baseline header should contribute UI to the top bar. The
 * parent uses this to decide whether to render the row at all in
 * combination with the primary dump selector.
 */
export function shouldShowBaselineHeader(): boolean {
  const traces = getBaselineTraces();
  const {loading, error} = getLoadState();
  const hasError = error !== null && getActiveBaseline() === null;
  return traces.length > 0 || loading || hasError;
}

/**
 * Triggers the hidden file input owned by the most recently mounted
 * baseline header instance, if any. Lets the Overview-tab CTA share the
 * same picker as the top-bar selector — no parallel hidden inputs that
 * need separate state to coordinate.
 */
let openFilePickerImpl: (() => void) | null = null;
export function openBaselineFilePicker(): void {
  if (openFilePickerImpl) {
    openFilePickerImpl();
  } else {
    // Header not yet mounted (e.g. trace just loaded). Push the request
    // onto the next animation frame so the input has a chance to render.
    requestAnimationFrame(() => openFilePickerImpl?.());
  }
}

interface HeapDumpDiffHeaderAttrs {
  readonly trace: Trace;
}

export class HeapDumpDiffHeader
  implements m.ClassComponent<HeapDumpDiffHeaderAttrs>
{
  private inputEl: HTMLInputElement | null = null;

  oncreate() {
    openFilePickerImpl = () => this.inputEl?.click();
  }
  onremove() {
    openFilePickerImpl = null;
  }
  view({attrs}: m.Vnode<HeapDumpDiffHeaderAttrs>): m.Children {
    const traces = getBaselineTraces();
    const active = getActiveBaseline();
    const {loading, progressPct, error} = getLoadState();
    const hidden = !shouldShowBaselineHeader();

    // The hidden file input must always render so the Overview-tab CTA
    // (which fires `openBaselineFilePicker`) has something to click. The
    // rest of the row collapses to nothing when there's no pool / load /
    // error state to show.
    const fileInput = m('input', {
      'type': 'file',
      'accept': FILE_ACCEPT,
      'style': 'display:none',
      'aria-hidden': 'true',
      'oncreate': (v) => {
        this.inputEl = v.dom as HTMLInputElement;
      },
      'onchange': async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        await triggerFileLoad(attrs.trace.raf, file);
        if (this.inputEl) this.inputEl.value = '';
      },
    });

    if (hidden) return fileInput;

    return [
      fileInput,
      loading ? renderLoadingCallout(progressPct) : null,
      error && !active ? renderErrorCallout(error) : null,
      m('span', {class: 'ah-top-bar__label'}, 'Baseline:'),
      renderBaselineSelector(traces, active, attrs.trace, () =>
        this.inputEl?.click(),
      ),
      active
        ? m(SegmentedButtons, {
            'options': MODES.map((m) => ({label: m.label})),
            'selectedOption': MODES.findIndex((m) => m.key === getMode()),
            'onOptionSelected': (i) => setMode(MODES[i].key),
            'aria-label': 'Diff mode',
          })
        : null,
      active
        ? m(Button, {
            'icon': 'close',
            'variant': ButtonVariant.Minimal,
            'compact': true,
            'title': 'Clear active baseline',
            'aria-label': 'Clear active baseline',
            'onclick': () => clearActiveBaseline(),
          })
        : null,
      traces.length > 0
        ? m(Button, {
            'icon': 'delete_forever',
            'variant': ButtonVariant.Minimal,
            'compact': true,
            'title': 'Remove all baseline traces',
            'aria-label': 'Remove all baseline traces',
            'onclick': () => disposeBaseline(),
          })
        : null,
    ];
  }
}

function renderLoadingCallout(progressPct: number): m.Children {
  return m(
    Callout,
    {icon: 'hourglass_empty', intent: Intent.None},
    `Loading baseline trace… ${progressPct}%`,
  );
}

function renderErrorCallout(message: string): m.Children {
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
    message,
  );
}

function renderBaselineSelector(
  traces: ReadonlyArray<BaselineTrace>,
  active: BaselineDumpRef | null,
  trace: Trace,
  openFilePicker: () => void,
): m.Children {
  const triggerLabel = active ? activeLabel(active) : 'None — pick to diff';
  return m(
    PopupMenu,
    {
      trigger: m(Button, {
        label: triggerLabel,
        icon: 'difference',
        rightIcon: 'arrow_drop_down',
        variant: ButtonVariant.Outlined,
        compact: true,
      }),
    },
    [
      ...traces.flatMap((t) => renderTraceSection(t, active, trace)),
      traces.length > 0 ? m(MenuDivider) : null,
      m(MenuItem, {
        label: 'Add baseline trace…',
        icon: 'upload_file',
        onclick: openFilePicker,
      }),
      active
        ? m(MenuItem, {
            label: 'Clear active baseline',
            icon: 'close',
            onclick: () => clearActiveBaseline(),
          })
        : null,
    ],
  );
}

function renderTraceSection(
  t: BaselineTrace,
  active: BaselineDumpRef | null,
  trace: Trace,
): m.Children[] {
  const heading = m(MenuItem, {
    label: m('span', {class: 'ah-top-bar__section-title'}, t.title),
    icon: 'folder_open',
    closePopupOnClick: false,
    onclick: () => {},
  });
  const dumpItems = t.dumps.map((d) =>
    m(MenuItem, {
      label: dumpLabel(d, trace),
      icon: active && active.trace === t && active.dump === d ? 'check' : '',
      onclick: () => setActiveBaseline({trace: t, dump: d}),
    }),
  );
  const removeItem = m(MenuItem, {
    label: `Remove "${t.title}"`,
    icon: 'delete',
    onclick: () => removeBaselineTrace(t.id),
  });
  return [heading, ...dumpItems, removeItem, m(MenuDivider)];
}

function activeLabel(b: BaselineDumpRef): string {
  return `${b.trace.title} · ${dumpProcessLabel(b.dump)}`;
}

function dumpLabel(d: HeapDump, trace: Trace): string {
  const offset = formatDuration(
    trace,
    Time.diff(Time.fromRaw(d.ts), trace.traceInfo.start),
  );
  return `${dumpProcessLabel(d)} — ${offset}`;
}

function dumpProcessLabel(d: HeapDump): string {
  return d.processName !== null
    ? `${d.processName} (pid ${d.pid})`
    : `pid ${d.pid}`;
}
