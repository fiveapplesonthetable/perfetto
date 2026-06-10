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

// Specialized renderer for the "FILESYSTEMS & FREE SPACE (df)" section:
//   Filesystem        1K-blocks   Used Available Use% Mounted on
//   /dev/block/dm-9      788084 788084         0 100% /
//   tmpfs               8176224   3496   8172728   1% /dev
// rendered as a sortable table with numeric size columns (in kB).

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import {renderUnparsed} from './render_utils';

const SCHEMA: SchemaRegistry = {
  query: {
    filesystem: {
      title: 'Filesystem',
      columnType: 'text',
    },
    size_kb: {
      title: 'Size (kB)',
      columnType: 'quantitative',
    },
    used_kb: {
      title: 'Used (kB)',
      columnType: 'quantitative',
    },
    avail_kb: {
      title: 'Avail (kB)',
      columnType: 'quantitative',
    },
    use_pct: {
      title: 'Use %',
      columnType: 'quantitative',
    },
    mounted_on: {
      title: 'Mounted on',
      columnType: 'text',
    },
  },
};

// "/dev/block/dm-9      788084 788084         0 100% /".
const ROW_RE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;

interface ParseResult {
  readonly rows: Row[];
  readonly unparsed: string[];
}

function parse(lines: ReadonlyArray<string>): ParseResult {
  const res: ParseResult = {rows: [], unparsed: []};
  for (const line of lines) {
    if (line.trim() === '') continue;
    // The column header line.
    if (line.startsWith('Filesystem')) continue;
    const match = ROW_RE.exec(line);
    if (match === null) {
      res.unparsed.push(line);
      continue;
    }
    res.rows.push({
      filesystem: match[1],
      size_kb: Number(match[2]),
      used_kb: Number(match[3]),
      avail_kb: Number(match[4]),
      use_pct: Number(match[5]),
      mounted_on: match[6].trim(),
    });
  }
  return res;
}

interface DfViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class DfView implements m.ClassComponent<DfViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ParseResult = parse([]);

  view({attrs}: m.CVnode<DfViewAttrs>): m.Children {
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
          {id: 'filesystem', field: 'filesystem'},
          {id: 'size_kb', field: 'size_kb'},
          {id: 'used_kb', field: 'used_kb'},
          {id: 'avail_kb', field: 'avail_kb'},
          {id: 'use_pct', field: 'use_pct'},
          {id: 'mounted_on', field: 'mounted_on'},
        ],
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const dfRenderer: SectionRenderer = {
  id: 'df',
  matches: (sel) =>
    sel.service === undefined &&
    sel.section.startsWith('FILESYSTEMS & FREE SPACE'),
  render: (lines) => m(DfView, {lines}),
};
