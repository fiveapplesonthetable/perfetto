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

// Specialized renderer for the 'meminfo' dumpsys service ("DUMP OF SERVICE
// HIGH meminfo"). It surfaces the device-wide summary at the end of the dump:
//   Total PSS by process:
//       216,067K: system (pid 1211)                        (      0K in swap)
//   Total PSS by OOM adjustment:
//       488,843K: Native                                   (      0K in swap)
//            60,046K: zygote (pid 874)                     (      0K in swap)
//   Total PSS by category:
//       398,068K: .so mmap                                 (  4,880K in swap)
//   Total RAM: 16,352,452K (status normal)
//    Free RAM: 14,136,876K (...)
// as a key/value summary header plus three sortable tables. The (large)
// per-process "** MEMINFO in pid ..." blocks are left to the Raw view.

import m from 'mithril';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../../trace_processor/query_result';
import type {SectionRenderer} from './registry';
import type {KvEntry} from './render_utils';
import {parseKb, renderKvBlock, renderUnparsed} from './render_utils';

const PROCESS_SCHEMA: SchemaRegistry = {
  query: {
    pss_kb: {
      title: 'PSS (kB)',
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
    swap_kb: {
      title: 'Swap (kB)',
      columnType: 'quantitative',
    },
  },
};

const OOM_SCHEMA: SchemaRegistry = {
  query: {
    oom_adj: {
      title: 'OOM adjustment',
      columnType: 'text',
    },
    pss_kb: {
      title: 'PSS (kB)',
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
    swap_kb: {
      title: 'Swap (kB)',
      columnType: 'quantitative',
    },
  },
};

const CATEGORY_SCHEMA: SchemaRegistry = {
  query: {
    category: {
      title: 'Category',
      columnType: 'text',
    },
    subcategory: {
      title: 'Subcategory',
      columnType: 'text',
    },
    pss_kb: {
      title: 'PSS (kB)',
      columnType: 'quantitative',
    },
    swap_kb: {
      title: 'Swap (kB)',
      columnType: 'quantitative',
    },
  },
};

// "    216,067K: name ...                  (        0K in swap)". The swap
// suffix is optional (older releases don't print it).
const ENTRY_RE = /^(\s+)([\d,]+)K: (.+?)\s*(?:\(\s*([\d,]+)K in swap\))?$/;
// "(pid 1211)" / "(pid 4886 / activities)" suffix inside an entry name.
const PID_RE = /\s*\(pid (\d+)[^)]*\)$/;
// " Used RAM: 1,952,064K (...)" style summary lines.
const SUMMARY_RE =
  /^\s*(Total RAM|Free RAM|Used RAM|Lost RAM|ZRAM|Tuning|DMA-BUF(?: Heaps(?: pool)?)?|GPU|Kernel CMA):\s+(.*)$/;

// Top-level list entries are indented by ~4 spaces; entries nested under an
// OOM bucket / category by ~9.
const NESTED_INDENT = 6;

type ListKind = 'process' | 'oom' | 'category';

interface ParseResult {
  readonly summary: KvEntry[];
  readonly processRows: Row[];
  readonly oomRows: Row[];
  readonly categoryRows: Row[];
  readonly unparsed: string[];
}

function parse(lines: ReadonlyArray<string>): ParseResult {
  const res: ParseResult = {
    summary: [],
    processRows: [],
    oomRows: [],
    categoryRows: [],
    unparsed: [],
  };
  let list: ListKind | undefined = undefined;
  let oomBucket: string | null = null;
  let category: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') {
      list = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === 'Total PSS by process:') {
      list = 'process';
      continue;
    }
    if (trimmed === 'Total PSS by OOM adjustment:') {
      list = 'oom';
      oomBucket = null;
      continue;
    }
    if (trimmed === 'Total PSS by category:') {
      list = 'category';
      category = null;
      continue;
    }
    const summary = SUMMARY_RE.exec(line);
    if (summary !== null) {
      list = undefined;
      res.summary.push({key: summary[1], value: summary[2]});
      continue;
    }
    const entry = list !== undefined ? ENTRY_RE.exec(line) : null;
    if (list === undefined || entry === null) {
      res.unparsed.push(line);
      continue;
    }
    const nested = entry[1].length > NESTED_INDENT;
    const pssKb = parseKb(entry[2]);
    const swapKb = entry[4] !== undefined ? parseKb(entry[4]) : null;
    const pidMatch = PID_RE.exec(entry[3]);
    const pid = pidMatch !== null ? Number(pidMatch[1]) : null;
    const name = entry[3].replace(PID_RE, '');
    switch (list) {
      case 'process':
        res.processRows.push({
          pss_kb: pssKb,
          process: name,
          pid,
          swap_kb: swapKb,
        });
        break;
      case 'oom':
        if (!nested) oomBucket = name;
        res.oomRows.push({
          oom_adj: oomBucket,
          pss_kb: pssKb,
          process: nested ? name : null,
          pid,
          swap_kb: swapKb,
        });
        break;
      case 'category':
        if (!nested) category = name;
        res.categoryRows.push({
          category: nested ? category : name,
          subcategory: nested ? name : null,
          pss_kb: pssKb,
          swap_kb: swapKb,
        });
        break;
    }
  }
  return res;
}

function renderSubGrid(
  title: string,
  schema: SchemaRegistry,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<Row>,
): m.Children {
  if (rows.length === 0) return null;
  return [
    m('.pf-bre-subheading', title),
    m(
      '.pf-bre-subgrid',
      m(DataGrid, {
        schema,
        rootSchema: 'query',
        data: rows,
        initialColumns: columns.map((c) => ({id: c, field: c})),
        fillHeight: true,
      }),
    ),
  ];
}

interface MeminfoViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

// Caches the parsed rows by the identity of the lines array so redraws don't
// re-parse the section.
class MeminfoView implements m.ClassComponent<MeminfoViewAttrs> {
  private lastLines?: ReadonlyArray<string>;
  private parsed: ParseResult = parse([]);

  view({attrs}: m.CVnode<MeminfoViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.parsed = parse(attrs.lines);
    }
    return m('.pf-bre-stacked', [
      renderKvBlock(this.parsed.summary),
      renderSubGrid(
        'Total PSS by process',
        PROCESS_SCHEMA,
        ['pss_kb', 'process', 'pid', 'swap_kb'],
        this.parsed.processRows,
      ),
      renderSubGrid(
        'Total PSS by OOM adjustment',
        OOM_SCHEMA,
        ['oom_adj', 'pss_kb', 'process', 'pid', 'swap_kb'],
        this.parsed.oomRows,
      ),
      renderSubGrid(
        'Total PSS by category',
        CATEGORY_SCHEMA,
        ['category', 'subcategory', 'pss_kb', 'swap_kb'],
        this.parsed.categoryRows,
      ),
      renderUnparsed(this.parsed.unparsed),
    ]);
  }
}

export const meminfoRenderer: SectionRenderer = {
  id: 'meminfo',
  matches: (sel) => sel.service === 'meminfo',
  render: (lines) => m(MeminfoView, {lines}),
};
