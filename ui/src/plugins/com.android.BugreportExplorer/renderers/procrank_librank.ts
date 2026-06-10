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

// Specialized renderer for the "PROCRANK" and "LIBRANK" sections.
//
// PROCRANK (canonical AOSP format; devices with zram, like cuttlefish,
// append Swap/PSwap/USwap/ZSwap columns — the header is parsed dynamically
// so both variants work):
//     PID       Vss      Rss      Pss      Uss  cmdline
//    1211  18742684K  428844K  216096K  184304K  system_server
//                             ------   ------  ------
//                            1654500K 1242652K  TOTAL
//   ZRAM: 60260K physical used for 132464K in swap (12264332K total swap)
//    RAM: 16352452K total, 12171912K free, ...
//
// LIBRANK groups per-process rows under each mapping (the group row carries
// RSStot + the library name; the Swap column is absent on swapless devices):
//    RSStot       VSS      RSS      PSS      USS     Swap  Name/PID
//   238395K                                                [anon:scudo:primary]
//              72192K   31184K   28343K   28296K       0K    com.android.systemui [3335]
// Both are flattened into sortable tables with kB columns.

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {
  ColumnSchema,
  SchemaRegistry,
} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import type {KvEntry} from './render_utils';
import {parseKb, renderKvBlock, renderUnparsed} from './render_utils';

// ---- PROCRANK ----

// "  PID       Vss      Rss      Pss      Uss  [...]  cmdline".
const PROCRANK_HEADER_RE = /^\s*PID\s+.*\bcmdline\s*$/;
const PROCRANK_ROW_RE = /^\s*(\d+)\s+(.+)$/;
// The "------   ------" separator above the TOTAL row.
const SEPARATOR_RE = /^[\s-]+$/;
const PROCRANK_TOTAL_RE = /^\s*((?:[\d,]+K\s+)+)TOTAL\s*$/;
const PROCRANK_FOOTER_RE = /^\s*(RAM|ZRAM):\s+(.*)$/;

interface ProcrankParseResult {
  readonly schema: SchemaRegistry;
  readonly columns: string[];
  readonly rows: Row[];
  readonly footer: KvEntry[];
  readonly unparsed: string[];
}

function parseProcrank(lines: ReadonlyArray<string>): ProcrankParseResult {
  const columnsSchema: ColumnSchema = {
    pid: {title: 'PID', columnType: 'identifier'},
  };
  const columns: string[] = ['pid'];
  // The kB column fields, in header order (filled in from the header line).
  let kbFields: string[] = [];
  const res: ProcrankParseResult = {
    schema: {query: columnsSchema},
    columns,
    rows: [],
    footer: [],
    unparsed: [],
  };
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (PROCRANK_HEADER_RE.test(line) && kbFields.length === 0) {
      // E.g. ["PID", "Vss", "Rss", "Pss", "Uss", ..., "cmdline"].
      const tokens = line.trim().split(/\s+/);
      kbFields = tokens.slice(1, -1).map((t) => `${t.toLowerCase()}_kb`);
      for (let i = 0; i < kbFields.length; i++) {
        columnsSchema[kbFields[i]] = {
          title: `${tokens[i + 1]} (kB)`,
          columnType: 'quantitative',
        };
        columns.push(kbFields[i]);
      }
      columnsSchema['cmdline'] = {title: 'Cmdline', columnType: 'text'};
      columns.push('cmdline');
      continue;
    }
    if (SEPARATOR_RE.test(line)) continue;
    const total = PROCRANK_TOTAL_RE.exec(line);
    if (total !== null) {
      res.footer.push({key: 'TOTAL', value: total[1].trim()});
      continue;
    }
    const footer = PROCRANK_FOOTER_RE.exec(line);
    if (footer !== null) {
      res.footer.push({key: footer[1], value: footer[2]});
      continue;
    }
    const match = kbFields.length > 0 ? PROCRANK_ROW_RE.exec(line) : null;
    if (match !== null) {
      const tokens = match[2].trim().split(/\s+/);
      const kbValues = tokens.slice(0, kbFields.length).map(parseKb);
      if (tokens.length > kbFields.length && !kbValues.includes(null)) {
        const row: Row = {pid: Number(match[1])};
        for (let i = 0; i < kbFields.length; i++) {
          row[kbFields[i]] = kbValues[i];
        }
        row['cmdline'] = tokens.slice(kbFields.length).join(' ');
        res.rows.push(row);
        continue;
      }
    }
    res.unparsed.push(line);
  }
  return res;
}

// ---- LIBRANK ----

const LIBRANK_SCHEMA: SchemaRegistry = {
  query: {
    library: {
      title: 'Library',
      columnType: 'text',
    },
    library_rsstot_kb: {
      title: 'Lib RSStot (kB)',
      columnType: 'quantitative',
    },
    process: {
      title: 'Process',
      columnType: 'text',
    },
    pid: {
      title: 'PID',
      columnType: 'identifier',
    },
    vss_kb: {
      title: 'VSS (kB)',
      columnType: 'quantitative',
    },
    rss_kb: {
      title: 'RSS (kB)',
      columnType: 'quantitative',
    },
    pss_kb: {
      title: 'PSS (kB)',
      columnType: 'quantitative',
    },
    uss_kb: {
      title: 'USS (kB)',
      columnType: 'quantitative',
    },
    swap_kb: {
      title: 'Swap (kB)',
      columnType: 'quantitative',
    },
  },
};

const LIBRANK_COLUMNS = [
  'library',
  'library_rsstot_kb',
  'process',
  'pid',
  'vss_kb',
  'rss_kb',
  'pss_kb',
  'uss_kb',
  'swap_kb',
];

// "    72192K   31184K   28343K   28296K       0K    com.android.systemui
// [3335]" (the Swap value is absent on swapless devices).
const LIBRANK_PROC_RE =
  /^\s+([\d,]+)K\s+([\d,]+)K\s+([\d,]+)K\s+([\d,]+)K(?:\s+([\d,]+)K)?\s+(.+?)\s+\[(\d+)\]$/;
// "238395K                            [anon:scudo:primary]" (group row).
const LIBRANK_GROUP_RE = /^\s*([\d,]+)K\s+(\S.*)$/;
const LIBRANK_HEADER_RE = /^\s*RSStot\s+.*\bName\/PID\s*$/;

interface LibrankParseResult {
  readonly rows: Row[];
  readonly unparsed: string[];
}

function parseLibrank(lines: ReadonlyArray<string>): LibrankParseResult {
  const res: LibrankParseResult = {rows: [], unparsed: []};
  let library: string | null = null;
  let libraryRsstot: number | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (LIBRANK_HEADER_RE.test(line)) continue;
    const proc = LIBRANK_PROC_RE.exec(line);
    if (proc !== null) {
      res.rows.push({
        library,
        library_rsstot_kb: libraryRsstot,
        process: proc[6],
        pid: Number(proc[7]),
        vss_kb: parseKb(proc[1]),
        rss_kb: parseKb(proc[2]),
        pss_kb: parseKb(proc[3]),
        uss_kb: parseKb(proc[4]),
        swap_kb: proc[5] !== undefined ? parseKb(proc[5]) : null,
      });
      continue;
    }
    const group = LIBRANK_GROUP_RE.exec(line);
    if (group !== null) {
      libraryRsstot = parseKb(group[1]);
      library = group[2].trim();
      continue;
    }
    res.unparsed.push(line);
  }
  return res;
}

// ---- Views ----

interface RankViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class ProcrankView implements m.ClassComponent<RankViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ProcrankParseResult = parseProcrank([]);

  view({attrs}: m.CVnode<RankViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.parsed = parseProcrank(attrs.lines);
    }
    return m('.pf-bre-grid-container', [
      renderKvBlock(this.parsed.footer),
      m(DataGrid, {
        schema: this.parsed.schema,
        rootSchema: 'query',
        data: this.parsed.rows,
        initialColumns: this.parsed.columns.map((c) => ({id: c, field: c})),
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

class LibrankView implements m.ClassComponent<RankViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: LibrankParseResult = parseLibrank([]);

  view({attrs}: m.CVnode<RankViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.parsed = parseLibrank(attrs.lines);
    }
    return m('.pf-bre-grid-container', [
      m(DataGrid, {
        schema: LIBRANK_SCHEMA,
        rootSchema: 'query',
        data: this.parsed.rows,
        initialColumns: LIBRANK_COLUMNS.map((c) => ({id: c, field: c})),
        fillHeight: true,
      }),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const procrankLibrankRenderer: SectionRenderer = {
  id: 'procrank-librank',
  matches: (sel) =>
    sel.service === undefined &&
    (sel.section.startsWith('PROCRANK') || sel.section.startsWith('LIBRANK')),
  render: (lines, ctx) =>
    ctx.selection.section.startsWith('LIBRANK')
      ? m(LibrankView, {lines})
      : m(ProcrankView, {lines}),
};
