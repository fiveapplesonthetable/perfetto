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

// Small shared helpers for the specialized section renderers: parsing
// comma-grouped kilobyte values, a key/value header block and a collapsed
// "N unrecognized lines" <details> footer so table renderers never show a
// blank panel when the format drifts.

import m from 'mithril';

// Cap on the number of unrecognized lines shown in the <details> block.
const MAX_UNPARSED_SHOWN = 500;

// Parses "181,683" / "181,683K" / "  216,067K" into 181683. Returns null for
// anything that isn't a (comma-grouped) number.
export function parseKb(value: string): number | null {
  const match = /^\s*([\d,]+)K?\s*$/.exec(value);
  if (match === null) return null;
  return Number(match[1].replaceAll(',', ''));
}

export interface KvEntry {
  readonly key: string;
  readonly value: string;
}

// A compact two-column key/value header block (e.g. the meminfo Total/Free/
// Used/Lost RAM summary or the cpuinfo Load line).
export function renderKvBlock(entries: ReadonlyArray<KvEntry>): m.Children {
  if (entries.length === 0) return null;
  return m(
    '.pf-bre-kv',
    entries.map((e) => [
      m('span.pf-bre-kv__key', e.key),
      m('span.pf-bre-kv__value', e.value),
    ]),
  );
}

// Renders the lines a specialized renderer could not parse as a collapsed
// <details> block, so nothing is silently dropped. Returns null when there is
// nothing unparsed.
export function renderUnparsed(lines: ReadonlyArray<string>): m.Children {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, MAX_UNPARSED_SHOWN);
  return m(
    'details.pf-bre-unparsed',
    m(
      'summary',
      `${lines.length.toLocaleString()} unrecognized line` +
        (lines.length === 1 ? '' : 's'),
    ),
    m(
      '.pf-bre-unparsed__lines',
      shown.map((l) => m('.pf-bre-raw__line', l === '' ? ' ' : l)),
      lines.length > MAX_UNPARSED_SHOWN &&
        m(
          '.pf-bre-truncation-note',
          `… ${(lines.length - MAX_UNPARSED_SHOWN).toLocaleString()} more ` +
            'lines (switch to Raw view to see everything)',
        ),
    ),
  );
}
