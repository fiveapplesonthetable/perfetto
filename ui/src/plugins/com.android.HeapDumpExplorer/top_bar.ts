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

// Combined top bar that hosts both the primary heap-dump selector AND the
// baseline pool / diff controls in a single row. The row only renders when
// at least one of the two has something to show — the common
// single-trace, no-diff workflow keeps the page chrome to nothing. Overview
// renders its own "Diff against another trace" CTA in that case so the
// entry point is still discoverable without claiming vertical space at the
// top of every tab.
//
// Visibility table:
//
//   primary > 1 dump  | baseline pool / loading / error  | row visible
//   ----------------- | -------------------------------- | -----------
//   no                | no                               | hidden
//   yes               | no                               | shown (just primary)
//   no                | yes                              | shown (just baseline)
//   yes               | yes                              | shown (both inline)

import m from 'mithril';
import {Trace} from '../../public/trace';
import {DumpSelector, shouldShowDumpSelector} from './dumps/selector';
import {HeapDumpDiffHeader, shouldShowBaselineHeader} from './header';

interface TopBarAttrs {
  readonly trace: Trace;
}

export class TopBar implements m.ClassComponent<TopBarAttrs> {
  view({attrs}: m.Vnode<TopBarAttrs>): m.Children {
    const hasPrimary = shouldShowDumpSelector();
    const hasBaseline = shouldShowBaselineHeader();
    // The HeapDumpDiffHeader keeps a hidden file input mounted so the
    // Overview-tab CTA can fire it. Render the header component even when
    // the visible row collapses — it returns just the input in that case.
    if (!hasPrimary && !hasBaseline) {
      return m('div', {class: 'ah-top-bar ah-top-bar--hidden'}, [
        m(HeapDumpDiffHeader, {trace: attrs.trace}),
      ]);
    }
    return m(
      'div',
      {class: 'ah-top-bar'},
      hasPrimary ? m(DumpSelector, {trace: attrs.trace}) : null,
      hasPrimary && hasBaseline
        ? m('span', {class: 'ah-top-bar__separator'}, '|')
        : null,
      m(HeapDumpDiffHeader, {trace: attrs.trace}),
    );
  }
}
