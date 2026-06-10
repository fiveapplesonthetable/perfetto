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

// Specialized renderer for the 'dropbox' dumpsys service. The entry list
// (format stable since SDK 21) looks like:
//   Drop box contents: 52 entries
//   ...
//   2026-06-10 09:02:08 storage_trim (text, 16 bytes)
//   2026-06-10 09:02:09 system_server_strictmode (text, 1774 bytes)
// and is rendered as a sortable timestamp/tag/type/size table. Crash-ish tags
// (crashes, ANRs, watchdog) are usually the most interesting bits.

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';

const SCHEMA: SchemaRegistry = {
  query: {
    timestamp: {
      title: 'Timestamp',
      columnType: 'text',
    },
    tag: {
      title: 'Tag',
      columnType: 'text',
    },
    type: {
      title: 'Type',
      columnType: 'text',
    },
    size_bytes: {
      title: 'Size (bytes)',
      columnType: 'quantitative',
    },
  },
};

// "2026-06-10 09:02:08 tag (text, 16 bytes)". The parenthesized details are
// optional ("(*** lost ***)" style entries have no size).
const ENTRY_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+?)(?: \((\w+), (\d+) bytes\))?$/;

interface DropboxViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class DropboxView implements m.ClassComponent<DropboxViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private rows: Row[] = [];

  view({attrs}: m.CVnode<DropboxViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.rows = [];
      for (const line of attrs.lines) {
        const match = ENTRY_RE.exec(line.trim());
        if (match !== null) {
          this.rows.push({
            timestamp: match[1],
            tag: match[2],
            type: match[3] ?? null,
            size_bytes: match[4] !== undefined ? Number(match[4]) : null,
          });
        }
      }
    }
    return m(
      '.pf-bre-grid-container',
      m(DataGrid, {
        schema: SCHEMA,
        rootSchema: 'query',
        data: this.rows,
        initialColumns: [
          {id: 'timestamp', field: 'timestamp'},
          {id: 'tag', field: 'tag'},
          {id: 'type', field: 'type'},
          {id: 'size_bytes', field: 'size_bytes'},
        ],
        fillHeight: true,
      }),
    );
  }
}

export const dropboxRenderer: SectionRenderer = {
  id: 'dropbox',
  matches: (sel) => sel.service === 'dropbox',
  render: (lines) => m(DropboxView, {lines}),
};
