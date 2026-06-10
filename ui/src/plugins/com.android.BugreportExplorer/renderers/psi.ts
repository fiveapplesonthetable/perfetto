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

// Specialized renderer for the pressure-stall sections "PSI cpu
// (/proc/pressure/cpu)", "PSI memory (...)" and "PSI io (...)":
//   some avg10=0.57 avg60=0.12 avg300=0.03 total=13842520
//   full avg10=0.00 avg60=0.00 avg300=0.00 total=0
// rendered as a small table (avgN are stall percentages over the last N
// seconds; total is the absolute stall time in microseconds).

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import {renderUnparsed} from './render_utils';

const SCHEMA: SchemaRegistry = {
  query: {
    kind: {
      title: 'Kind',
      columnType: 'text',
    },
    avg10: {
      title: 'Avg10 (%)',
      columnType: 'quantitative',
    },
    avg60: {
      title: 'Avg60 (%)',
      columnType: 'quantitative',
    },
    avg300: {
      title: 'Avg300 (%)',
      columnType: 'quantitative',
    },
    total_us: {
      title: 'Total (µs)',
      columnType: 'quantitative',
    },
  },
};

// "some avg10=0.57 avg60=0.12 avg300=0.03 total=13842520".
const ROW_RE =
  /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+) total=(\d+)$/;

interface ParseResult {
  readonly rows: Row[];
  readonly unparsed: string[];
}

function parse(lines: ReadonlyArray<string>): ParseResult {
  const res: ParseResult = {rows: [], unparsed: []};
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = ROW_RE.exec(line.trim());
    if (match === null) {
      res.unparsed.push(line);
      continue;
    }
    res.rows.push({
      kind: match[1],
      avg10: Number(match[2]),
      avg60: Number(match[3]),
      avg300: Number(match[4]),
      total_us: Number(match[5]),
    });
  }
  return res;
}

interface PsiViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class PsiView implements m.ClassComponent<PsiViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ParseResult = parse([]);

  view({attrs}: m.CVnode<PsiViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.parsed = parse(attrs.lines);
    }
    return m('.pf-bre-grid-container', [
      m(DataGrid, {
        schema: SCHEMA,
        rootSchema: 'query',
        data: this.parsed.rows,
        initialColumns: [
          {id: 'kind', field: 'kind'},
          {id: 'avg10', field: 'avg10'},
          {id: 'avg60', field: 'avg60'},
          {id: 'avg300', field: 'avg300'},
          {id: 'total_us', field: 'total_us'},
        ],
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const psiRenderer: SectionRenderer = {
  id: 'psi',
  matches: (sel) => sel.service === undefined && sel.section.startsWith('PSI '),
  render: (lines) => m(PsiView, {lines}),
};
