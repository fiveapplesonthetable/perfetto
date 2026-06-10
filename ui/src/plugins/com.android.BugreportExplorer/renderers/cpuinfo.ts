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

// Specialized renderer for the 'cpuinfo' dumpsys service ("DUMP OF SERVICE
// CRITICAL cpuinfo"). The dump looks like:
//   Load: 0.09 / 0.13 / 0.19
//   CPU usage from 546429ms to 246398ms ago (2026-06-10 09:12:11.332 to ...):
//     1.2% 1211/system_server: 0.5% user + 0.6% kernel / faults: 2429 minor
//    +0% 5390/kworker/14:0-events: 0% user + 0% kernel
//   0.4% TOTAL: 0.1% user + 0.2% kernel + 0% iowait + 0% irq + 0% softirq
// (a leading '+' marks processes that started during the sample window) and
// is rendered as a Load/period/TOTAL header plus a sortable per-process
// table.

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import type {KvEntry} from './render_utils';
import {renderKvBlock, renderUnparsed} from './render_utils';

const SCHEMA: SchemaRegistry = {
  query: {
    total_pct: {
      title: 'Total %',
      columnType: 'quantitative',
    },
    pid: {
      title: 'PID',
      columnType: 'identifier',
    },
    process: {
      title: 'Process',
      columnType: 'text',
    },
    user_pct: {
      title: 'User %',
      columnType: 'quantitative',
    },
    kernel_pct: {
      title: 'Kernel %',
      columnType: 'quantitative',
    },
    minor_faults: {
      title: 'Minor faults',
      columnType: 'quantitative',
    },
    major_faults: {
      title: 'Major faults',
      columnType: 'quantitative',
    },
  },
};

// "  1.2% 1211/system_server: 0.5% user + 0.6% kernel / faults: 2429 minor
// 12 major" (the faults part and the major count are optional).
const PROC_RE =
  /^\s*\+?([\d.]+)% (\d+)\/(.+?): ([\d.]+)% user \+ ([\d.]+)% kernel(?: \/ faults: (\d+) minor(?: (\d+) major)?)?\s*$/;
const TOTAL_RE = /^\s*([\d.]+)% TOTAL: (.*)$/;
const LOAD_RE = /^Load: (.*)$/;
const PERIOD_RE = /^CPU usage from (.*?):?$/;

interface ParseResult {
  readonly header: KvEntry[];
  readonly rows: Row[];
  readonly unparsed: string[];
}

function parse(lines: ReadonlyArray<string>): ParseResult {
  const res: ParseResult = {header: [], rows: [], unparsed: []};
  for (const line of lines) {
    if (line.trim() === '') continue;
    const load = LOAD_RE.exec(line);
    if (load !== null) {
      res.header.push({key: 'Load', value: load[1]});
      continue;
    }
    const period = PERIOD_RE.exec(line);
    if (period !== null) {
      res.header.push({key: 'CPU usage', value: `from ${period[1]}`});
      continue;
    }
    const total = TOTAL_RE.exec(line);
    if (total !== null) {
      res.header.push({key: 'TOTAL', value: `${total[1]}% (${total[2]})`});
      continue;
    }
    const proc = PROC_RE.exec(line);
    if (proc !== null) {
      res.rows.push({
        total_pct: Number(proc[1]),
        pid: Number(proc[2]),
        process: proc[3],
        user_pct: Number(proc[4]),
        kernel_pct: Number(proc[5]),
        minor_faults: proc[6] !== undefined ? Number(proc[6]) : null,
        major_faults: proc[7] !== undefined ? Number(proc[7]) : null,
      });
      continue;
    }
    res.unparsed.push(line);
  }
  return res;
}

interface CpuinfoViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class CpuinfoView implements m.ClassComponent<CpuinfoViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ParseResult = parse([]);

  view({attrs}: m.CVnode<CpuinfoViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.parsed = parse(attrs.lines);
    }
    return m('.pf-bre-grid-container', [
      renderKvBlock(this.parsed.header),
      m(DataGrid, {
        schema: SCHEMA,
        rootSchema: 'query',
        data: this.parsed.rows,
        initialColumns: [
          {id: 'total_pct', field: 'total_pct'},
          {id: 'pid', field: 'pid'},
          {id: 'process', field: 'process'},
          {id: 'user_pct', field: 'user_pct'},
          {id: 'kernel_pct', field: 'kernel_pct'},
          {id: 'minor_faults', field: 'minor_faults'},
          {id: 'major_faults', field: 'major_faults'},
        ],
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const cpuinfoRenderer: SectionRenderer = {
  id: 'cpuinfo',
  matches: (sel) => sel.service === 'cpuinfo',
  render: (lines) => m(CpuinfoView, {lines}),
};
