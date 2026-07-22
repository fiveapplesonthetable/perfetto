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

import './flamegraph_diff_legend.scss';
import m from 'mithril';

import {Button, ButtonVariant} from './button';
import {getDiffColorCss} from './flamegraph';

export interface FlamegraphDiffLegendAttrs {
  // Label for the colour basis (e.g. 'absolute', 'relative (%)').
  readonly basisLabel?: string;
  readonly title?: string;
  readonly negativeLabel?: string;
  readonly positiveLabel?: string;
}

// Legend for diff-coloured flamegraphs: a green→grey→red gradient painted
// from the same getDiffColorCss() the node fills use, so the legend and the
// boxes always agree.
export class FlamegraphDiffLegend implements m.ClassComponent<FlamegraphDiffLegendAttrs> {
  view({attrs}: m.CVnode<FlamegraphDiffLegendAttrs>): m.Children {
    const stops = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]
      .map((s) => getDiffColorCss(s))
      .join(', ');
    return m(
      '.pf-flamegraph-diff-legend',
      m(
        'span.pf-flamegraph-diff-legend__title',
        attrs.title ?? 'Change vs baseline',
      ),
      m(
        'span.pf-flamegraph-diff-legend__end',
        attrs.negativeLabel ?? 'smaller',
      ),
      m('.pf-flamegraph-diff-legend__bar', {
        style: {background: `linear-gradient(to right, ${stops})`},
      }),
      m('span.pf-flamegraph-diff-legend__end', attrs.positiveLabel ?? 'larger'),
      attrs.basisLabel !== undefined &&
        m(Button, {
          label: attrs.basisLabel,
          variant: ButtonVariant.Outlined,
          compact: true,
          disabled: true,
        }),
    );
  }
}
