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

// Specialized renderer for the dumpstate preamble (the lines before the first
// "------ SECTION ------" marker; stored with a NULL section and shown as
// "Header" in the section list — the registry sees it as section ''):
//   ========================================================
//   == dumpstate: 2026-06-10 09:21:16
//   ========================================================
//   Build: aosp_cf_x86_64_phone-userdebug ...
//   Build fingerprint: 'generic/aosp_cf_x86_64_phone/...'
//   Kernel: Linux version 6.12.38-...
//   Bootconfig: androidboot.hardware = "cutf_cvm"
//   androidboot.hardware.hwcomposer = "ranchu"     <- continuation lines
//   Uptime: up 0 weeks, ... load average: 0.42, 0.22, 0.20
//   Android SDK version: 36
// rendered as a clean key/value table ("key: value" lines plus the
// 'key = "value"' bootconfig continuation lines).

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import {renderUnparsed} from './render_utils';

const SCHEMA: SchemaRegistry = {
  query: {
    key: {
      title: 'Key',
      columnType: 'text',
    },
    value: {
      title: 'Value',
      columnType: 'text',
    },
  },
};

// "== dumpstate: 2026-06-10 09:21:16".
const DUMPSTATE_RE = /^== dumpstate: (.+)$/;
// "Build: ..." / "Android SDK version: 36" (un-indented, shortish key).
const KV_RE = /^([A-Za-z][\w .-]{0,40}):\s+(.*)$/;
// 'androidboot.hardware = "cutf_cvm"' bootconfig continuation lines.
const BOOTCONFIG_RE = /^([\w.-]+)\s*=\s*"?(.*?)"?$/;
// "====...====" banner lines around the dumpstate timestamp.
const BANNER_RE = /^=+$/;

interface ParseResult {
  readonly rows: Row[];
  readonly unparsed: string[];
}

function parse(lines: ReadonlyArray<string>): ParseResult {
  const res: ParseResult = {rows: [], unparsed: []};
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (BANNER_RE.test(line)) continue;
    const dumpstate = DUMPSTATE_RE.exec(line);
    if (dumpstate !== null) {
      res.rows.push({key: 'Dumpstate started', value: dumpstate[1]});
      continue;
    }
    const kv = KV_RE.exec(line);
    if (kv !== null) {
      res.rows.push({key: kv[1], value: kv[2]});
      continue;
    }
    const bootconfig = BOOTCONFIG_RE.exec(line);
    if (bootconfig !== null) {
      res.rows.push({key: bootconfig[1], value: bootconfig[2]});
      continue;
    }
    res.unparsed.push(line);
  }
  return res;
}

interface UptimeHeaderViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class UptimeHeaderView implements m.ClassComponent<UptimeHeaderViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ParseResult = parse([]);

  view({attrs}: m.CVnode<UptimeHeaderViewAttrs>): m.Children {
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
          {id: 'key', field: 'key'},
          {id: 'value', field: 'value'},
        ],
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const uptimeHeaderRenderer: SectionRenderer = {
  id: 'uptime-header',
  matches: (sel) => sel.service === undefined && sel.section === '',
  render: (lines) => m(UptimeHeaderView, {lines}),
};
