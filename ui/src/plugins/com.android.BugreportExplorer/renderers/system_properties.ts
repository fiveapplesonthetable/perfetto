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

// Specialized renderer for the "SYSTEM PROPERTIES (getprop)" section. Lines
// look like:
//   [ro.build.id]: [BP4A.251205.006]
// and are rendered as a filterable two-column property/value grid.

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';

const SCHEMA: SchemaRegistry = {
  query: {
    property: {
      title: 'Property',
      columnType: 'text',
    },
    value: {
      title: 'Value',
      columnType: 'text',
    },
  },
};

const PROP_RE = /^\[(.+?)\]:\s+\[(.*)\]$/;

interface SystemPropertiesViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class SystemPropertiesView
  implements m.ClassComponent<SystemPropertiesViewAttrs>
{
  private lastLines?: ReadonlyArray<string>;
  private rows: Row[] = [];

  view({attrs}: m.CVnode<SystemPropertiesViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.rows = [];
      for (const line of attrs.lines) {
        const match = PROP_RE.exec(line.trim());
        if (match !== null) {
          this.rows.push({property: match[1], value: match[2]});
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
          {id: 'property', field: 'property'},
          {id: 'value', field: 'value'},
        ],
        fillHeight: true,
      }),
    );
  }
}

export const systemPropertiesRenderer: SectionRenderer = {
  id: 'system-properties',
  matches: (sel) =>
    sel.service === undefined && sel.section.startsWith('SYSTEM PROPERTIES'),
  render: (lines) => m(SystemPropertiesView, {lines}),
};
