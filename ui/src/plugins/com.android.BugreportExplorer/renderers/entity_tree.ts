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

// Parses a dumpstate section / dumpsys service body into a tree of ENTITIES
// with PROPERTIES, TABLES and EVENT LOGS — the model behind the generic
// structured view (entity_view.ts).
//
// The parser implements the dumpsys text grammar derived from the AOSP
// printer implementations (PrintWriter-with-prefix record dumps,
// android.util.IndentingPrintWriter, DualDumpOutputStream text mode) and an
// exhaustive empirical classification of real bugreports. It is organized in
// two strictly separated layers:
//
//  1. An ORDERED RULE TABLE of line classifiers (`RULES`): one entry per
//     grammar line class, evaluated strictly in order — the first matching
//     rule wins; this ordering is what makes the rule set unambiguous. Each
//     rule is pure: it sees a single trimmed line (plus its whitespace token
//     split) and nothing else. To support a new line shape, add ONE rule
//     entry at the right position in the table and ONE classification test
//     in entity_tree_unittest.ts.
//
//  2. Separate, composable TREE-COMPOSITION passes that own all cross-line
//     context:
//       - detectIndentUnit(): per-section indent-unit detection (the
//         IndentingPrintWriter default is 2 spaces; 4-space, 1-space and
//         tab-indented sections exist);
//       - resolveTreeDraw(): box-drawing hierarchies ("│  ├─ ...") are
//         turned into synthetic indents and their payload re-classified;
//       - joinContinuations(): re-joins lines wrapped mid-value (unbalanced
//         brackets / IndentingPrintWriter wrapLength wrapping);
//       - compose(): indent-stack tree building, brace-balanced
//         DualDumpOutputStream blocks, table grouping (pipe + aligned
//         column forms), timestamped-event-run grouping, header adoption
//         and ALL-CAPS top-level section scoping.
//
// CONSERVATION INVARIANT: every non-blank input line is attributed to
// exactly one of {entity, property, text, table, event}; `counts` always
// sums to the number of non-blank input lines (console.assert-checked).
//
// This file is pure parsing (no mithril) so it is easy to test standalone.

export interface EntityProp {
  readonly key: string;
  readonly value: string;
}

// Structured tabular payload of an entity: either a real table (pipe or
// aligned-column form) or a grouped run of timestamped event-log lines
// (columns = Timestamp | Message). Rendered as a DataGrid by entity_view.
export interface EntityTable {
  readonly kind: 'table' | 'events';
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

export interface EntityNode {
  readonly id: number;
  // -1 for root entities.
  readonly parentId: number;
  // Cleaned entity name (bullet and trailing ':' stripped).
  readonly name: string;
  // Noisy remainder ("{a1b2c3 com.foo ...}" style), rendered as a dim suffix.
  readonly suffix: string;
  readonly depth: number;
  readonly children: EntityNode[];
  readonly props: EntityProp[];
  readonly text: string[];
  // Tabular payload for table / event-run entities.
  readonly table?: EntityTable;
}

// How each non-blank input line was classified, for sanity checking: the
// counts always sum to the number of non-blank input lines.
export interface LineCounts {
  entity: number;
  property: number;
  text: number;
  table: number;
  event: number;
}

export interface EntityTree {
  readonly roots: EntityNode[];
  // All entities in DFS order, indexed by id (for search/ancestor walks).
  readonly nodes: ReadonlyArray<EntityNode>;
  readonly counts: LineCounts;
}

// ---------------------------------------------------------------------------
// Layer 1: the ordered rule table of line classifiers.
// ---------------------------------------------------------------------------

export type LineClass =
  | 'SERVICE_HEADER'
  | 'SERVICE_FOOTER'
  | 'BLANKISH'
  | 'SEPARATOR'
  | 'TREE_DRAW'
  | 'TIMESTAMPED_EVENT'
  | 'RECORD_STAR'
  | 'RECORD_HASHN'
  | 'BRACE_DELIM'
  | 'BLOCK_OPEN'
  | 'TABLE_ROW_PIPE'
  | 'RECORD_BRACE'
  | 'KV_RUN'
  | 'KV_COLON_RUN'
  | 'HEADER_COLON'
  | 'PROPERTY_COLON'
  | 'PROPERTY_EQUALS'
  | 'ARROW_MAP'
  | 'BULLET_DASH'
  | 'RECORD_ID'
  | 'RECORD_PAREN'
  | 'ARRAY_VALUE'
  | 'TABLE_ROW_ALIGNED'
  | 'VALUE_ITEM'
  | 'BARE_LABEL'
  | 'PROSE';

// Shared sub-token regexes (timestamp shapes produced by TimeUtils
// sDumpDateFormat / logTimeOfDay, LocalLog ISO LocalDateTime and the
// EventLogger "MM-dd HH:mm:ss:SSS" colon-millis variant).
const TS_WALL_MS = String.raw`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,:]\d+)?(?:Z|[+-]\d{2}:?\d{2})?`;
const TS_MONTHDAY = String.raw`\d{2}-\d{2}[ T]?\d{2}:\d{2}:\d{2}(?:[.:,]\d{1,6})?(?=[ :.A-Za-z])`;
const TS_TIMEONLY = String.raw`\d{2}:\d{2}:\d{2}\.\d{3,6}`;
const TS_RE = new RegExp(`^(?:${TS_WALL_MS}|${TS_MONTHDAY}|${TS_TIMEONLY})\\b`);

// IndentingPrintWriter.printPair token: key=value where value is a quoted
// string, a bracketed/braced blob or any non-space run, optionally ','-ended.
const KV_TOKEN_RE = /^[^\s=]+=(?:"[^"]*"|\[[^\]]*\]|\{[^}]*\}|\S*),?$/;
// settings-style colon token: _id:115 name:adb_wifi_enabled ...
const KVC_TOKEN_RE = /^[A-Za-z_][\w.-]*:\S*$/;

const SERVICE_HEADER_RE = /^DUMP OF SERVICE (?:(?:CRITICAL|HIGH) )?\S+:$/;
const SERVICE_FOOTER_RE =
  /^--------- [\d.]+s was the duration of dumpsys \S+, ending at: .*$/;
// Rule line ("-----", "=====", ...) of >= 4 repeated punctuation chars.
const SEPARATOR_RULE_RE = /^([-=_*#~+.])\1{3,}$/;
// Banner ("=== TRANSACTIONS ===", "** Cache info ... **").
const SEPARATOR_BANNER_RE = /^[-=*#~]{2,}.*[-=*#~]{2,}$/;
// Dump-timeout diagnostics ("*** SERVICE 'x' DUMP TIMEOUT ... ***") also
// match SEPARATOR_BANNER_RE, as required by the grammar.
const TREE_DRAW_RE = /^[│├└┬]/u;
const RECORD_STAR_RE = /^\* \S/;
const RECORD_HASHN_RE = /^(?:#\d+|\S[^:=]{0,40}#\d+\b|\w+\[\d+\]:|\[\d+\] )/;
const BRACE_DELIM_RE = /^[\][}{),]+;?,?$/;
// "name={" / "name=[" (DualDumpOutputStream) and "name {" (proto-text).
const BLOCK_OPEN_RE = /^[\w.$ ]+ ?(?:\{|=\{|=\[)$/;
// Pipe table row: two or more '|' separators with content around them.
const TABLE_PIPE_RE = /.+\|.+\|/;
// "ClassName{...}" toString record (the text before '{' must carry no
// '='/':' — checked separately).
const RECORD_BRACE_RE = /^\*?\s*[A-Za-z][\w.$]* ?\{/;
const HEADER_COLON_RE = /^[^:]{1,100}:$/;
const PROP_COLON_A_RE = /^[^:]{1,100}:\s+\S.*$/;
const PROP_COLON_B_RE = /^[A-Za-z_][\w$.-]{0,60}:[^\s:][^:]*$/;
const PROP_EQ_B_RE = /^[^\s=]{1,200} = .*$/;
const PROP_EQ_C_RE = /^[^\s=]{1,200} ?= ?$/;
const PROP_EQ_D_RE = /^[^\s=]{1,200}=\S.*$/;
const ARROW_MAP_RE = /^\S.* (?:->|=>|→) /u;
const BULLET_DASH_RE = /^- \S/;
// Integer.toHexString(identityHashCode) prefix + payload.
const RECORD_ID_RE = /^[0-9a-f]{6,8} +\S/;
// "Class(args)" / "(csv, tuple)" with at most one nested paren level. The
// optional nested group wraps the trailing run too, keeping the match linear
// (no two adjacent [^()]* runs to backtrack between) on pathological lines.
const RECORD_PAREN_RE =
  /^(?:[A-Za-z][\w.$]*\([^()]*(?:\([^()]*\)[^()]*)?\)|\(.*\)),?$/;
const ARRAY_VALUE_A_RE = /^\[.*\],?$/;
const ARRAY_VALUE_B_RE = /^[\d.,%\s/+\-:xa-fA-F]+$/;
// 3+ columns separated by 2+ spaces (printf width formats), i.e.
// /\S+(\s{2,}\S+){2,}/ — implemented as a linear split (the backtracking
// regex form is quadratic on long non-matching lines).
const TABLE_ALIGNED_GAP_RE = /\s{2,}/;
const VALUE_ITEM_RE = /^[\w@$<>"/.\-+:#]+[,;]?$/;
// Disambiguation vs BARE_LABEL: a VALUE_ITEM must look value-ish (contain a
// digit or strong punctuation); a plain word like "Features" is a label.
const VALUE_ITEM_VALUEISH_RE = /[@$<>"/.:#\d]/;
const BARE_LABEL_RE = /^[A-Za-z][\w .\-/()&'"]{0,70}$/;

// The (pure, per-line) classification context: trimmed body + token split.
interface LineCtx {
  readonly body: string;
  readonly tokens: ReadonlyArray<string>;
}

interface ClassRule {
  readonly name: LineClass;
  readonly match: (c: LineCtx) => boolean;
}

// THE ordered rule table. First match wins. Do not reorder without updating
// the normative classification tests.
const RULES: ReadonlyArray<ClassRule> = [
  {name: 'SERVICE_HEADER', match: (c) => SERVICE_HEADER_RE.test(c.body)},
  {name: 'SERVICE_FOOTER', match: (c) => SERVICE_FOOTER_RE.test(c.body)},
  {name: 'BLANKISH', match: (c) => c.body === ''},
  {
    name: 'SEPARATOR',
    match: (c) =>
      SEPARATOR_RULE_RE.test(c.body) ||
      (c.body.length >= 6 &&
        !/^[A-Za-z0-9]/.test(c.body) &&
        SEPARATOR_BANNER_RE.test(c.body)),
  },
  {name: 'TREE_DRAW', match: (c) => TREE_DRAW_RE.test(c.body)},
  {name: 'TIMESTAMPED_EVENT', match: (c) => TS_RE.test(c.body)},
  {name: 'RECORD_STAR', match: (c) => RECORD_STAR_RE.test(c.body)},
  {name: 'RECORD_HASHN', match: (c) => RECORD_HASHN_RE.test(c.body)},
  {name: 'BRACE_DELIM', match: (c) => BRACE_DELIM_RE.test(c.body)},
  {name: 'BLOCK_OPEN', match: (c) => BLOCK_OPEN_RE.test(c.body)},
  // Pipe form must beat KV_RUN (pipe tables contain '=' cells); the aligned
  // form is probed much later so PROPERTY_COLON wins on 2+-space values.
  {
    name: 'TABLE_ROW_PIPE',
    match: (c) => c.body.includes('|') && TABLE_PIPE_RE.test(c.body),
  },
  {
    name: 'RECORD_BRACE',
    match: (c) => {
      if (!RECORD_BRACE_RE.test(c.body)) return false;
      const pre = c.body.substring(0, c.body.indexOf('{'));
      return !pre.includes('=') && !pre.includes(':');
    },
  },
  {
    name: 'KV_RUN',
    match: (c) => {
      const n = c.tokens.filter((t) => KV_TOKEN_RE.test(t)).length;
      return n >= 2 && n >= 0.6 * c.tokens.length;
    },
  },
  {
    name: 'KV_COLON_RUN',
    match: (c) => {
      const n = c.tokens.filter((t) => KVC_TOKEN_RE.test(t)).length;
      return n >= 3 && n >= 0.7 * c.tokens.length;
    },
  },
  {name: 'HEADER_COLON', match: (c) => HEADER_COLON_RE.test(c.body)},
  {
    name: 'PROPERTY_COLON',
    match: (c) => PROP_COLON_A_RE.test(c.body) || PROP_COLON_B_RE.test(c.body),
  },
  {
    name: 'PROPERTY_EQUALS',
    match: (c) =>
      KV_TOKEN_RE.test(c.body) ||
      PROP_EQ_B_RE.test(c.body) ||
      PROP_EQ_C_RE.test(c.body) ||
      (PROP_EQ_D_RE.test(c.body) && c.tokens[0].includes('=')),
  },
  {name: 'ARROW_MAP', match: (c) => ARROW_MAP_RE.test(c.body)},
  {name: 'BULLET_DASH', match: (c) => BULLET_DASH_RE.test(c.body)},
  {name: 'RECORD_ID', match: (c) => RECORD_ID_RE.test(c.body)},
  {name: 'RECORD_PAREN', match: (c) => RECORD_PAREN_RE.test(c.body)},
  {
    name: 'ARRAY_VALUE',
    match: (c) =>
      ARRAY_VALUE_A_RE.test(c.body) || ARRAY_VALUE_B_RE.test(c.body),
  },
  {
    name: 'TABLE_ROW_ALIGNED',
    match: (c) => c.body.split(TABLE_ALIGNED_GAP_RE).length >= 3,
  },
  {
    name: 'VALUE_ITEM',
    match: (c) =>
      c.tokens.length === 1 &&
      VALUE_ITEM_RE.test(c.body) &&
      VALUE_ITEM_VALUEISH_RE.test(c.body),
  },
  {
    name: 'BARE_LABEL',
    match: (c) => c.tokens.length <= 6 && BARE_LABEL_RE.test(c.body),
  },
  {name: 'PROSE', match: () => true},
];

// Pure line classifier: walks the ordered rule table.
export function classifyBody(body: string): LineClass {
  const ctx: LineCtx = {body, tokens: body === '' ? [] : body.split(/\s+/)};
  for (const rule of RULES) {
    if (rule.match(ctx)) return rule.name;
  }
  return 'PROSE'; // Unreachable: the PROSE rule always matches.
}

export interface ClassifiedLine {
  readonly cls: LineClass;
  readonly body: string;
  readonly indent: number;
}

export function classifyLine(raw: string): ClassifiedLine {
  const body = raw.trim();
  return {cls: classifyBody(body), body, indent: indentOf(raw)};
}

// Leading whitespace columns; tab advances to the next multiple of 8 (native
// printer convention). Only relative comparisons matter for nesting.
function indentOf(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === ' ') indent += 1;
    else if (ch === '\t') indent += 8 - (indent % 8);
    else break;
  }
  return indent;
}

// ---------------------------------------------------------------------------
// Layer 2, pass A: per-section indent-unit detection.
// ---------------------------------------------------------------------------

// The statistical mode of the positive indent deltas between a line and the
// next deeper line (ties broken towards the smaller delta). 2 spaces is the
// IndentingPrintWriter default and the global mode; 4/3/1-space and tab
// (counted as 8 columns) sections exist. Note the unit is only used for
// synthetic indents (tree-draw depth) — the composer never rejects odd
// indents: any indent > parent indent nests.
export function detectIndentUnit(lines: ReadonlyArray<ClassifiedLine>): number {
  const deltas = new Map<number, number>();
  let prev: number | undefined = undefined;
  for (const l of lines) {
    if (l.cls === 'BLANKISH') continue;
    if (prev !== undefined && l.indent > prev) {
      const d = l.indent - prev;
      deltas.set(d, (deltas.get(d) ?? 0) + 1);
    }
    prev = l.indent;
  }
  let unit = 2; // IndentingPrintWriter default "  ".
  let best = 0;
  for (const [d, n] of deltas) {
    if (n > best || (n === best && d < unit)) {
      unit = d;
      best = n;
    }
  }
  return unit;
}

// ---------------------------------------------------------------------------
// Layer 2, pass B: box-drawing tree resolution.
// ---------------------------------------------------------------------------

// A logical line: a classified line after the composition pre-passes. May
// aggregate several raw lines (continuation joining), tracked by nLines so
// the conservation counts stay exact.
interface LogicalLine {
  cls: LineClass;
  body: string;
  indent: number;
  nLines: number;
  // Tree-draw payloads always open an entity (each box-tree row is a record)
  // even when the payload classifies as a property/prose shape.
  forceEntity: boolean;
}

const TREE_PREFIX_RE = /^(?:[│├└┬][─\s]*)+/u;
const TREE_CELL_RE = /[│├└┬]/gu;

// Replaces "│  ├─ payload" lines with their payload, re-classified, at a
// synthetic indent derived from the box-cell count and the section's indent
// unit, so the box tree nests like a regular indented tree.
function resolveTreeDraw(
  lines: ReadonlyArray<ClassifiedLine>,
  unit: number,
): LogicalLine[] {
  return lines.map((l) => {
    if (l.cls !== 'TREE_DRAW') {
      return {...l, nLines: 1, forceEntity: false};
    }
    const prefix = TREE_PREFIX_RE.exec(l.body)?.[0] ?? '';
    const payload = l.body.substring(prefix.length).trim();
    const cells = prefix.match(TREE_CELL_RE)?.length ?? 1;
    if (payload === '') {
      return {
        cls: 'PROSE',
        body: l.body,
        indent: l.indent,
        nLines: 1,
        forceEntity: false,
      };
    }
    return {
      cls: classifyBody(payload),
      body: payload,
      indent: l.indent + cells * unit,
      nLines: 1,
      forceEntity: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Layer 2, pass C: continuation joining.
// ---------------------------------------------------------------------------

// Quote-aware bracket balance ('"..."' contents ignored). includeParens is
// used for continuation detection; brace blocks balance only {} and [].
function bracketBalance(s: string, includeParens: boolean): number {
  let bal = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote) {
      if (ch === '{' || ch === '[' || (includeParens && ch === '(')) bal++;
      else if (ch === '}' || ch === ']' || (includeParens && ch === ')')) {
        bal--;
      }
    }
  }
  return bal;
}

// Classes that can absorb a wrapped continuation (leaf-ish shapes; the
// node-opening and brace-block classes are handled by the brace machinery).
const JOINABLE_PREV = new Set<LineClass>([
  'PROPERTY_COLON',
  'PROPERTY_EQUALS',
  'KV_RUN',
  'KV_COLON_RUN',
  'ARROW_MAP',
  'ARRAY_VALUE',
  'VALUE_ITEM',
  'PROSE',
]);
const JOINABLE_CUR = new Set<LineClass>(['PROSE', 'VALUE_ITEM', 'ARRAY_VALUE']);
const MAX_JOINED_LINES = 20;

// Joins IndentingPrintWriter wrap-continuations: the previous line ended
// without structural closure (unbalanced bracket or trailing '='), the
// current line is value/prose-shaped and not shallower. The joined line is
// re-classified (a wrapped KV_RUN halves back into one KV_RUN).
// Deliberate deviation from the grammar note: a trailing ',' alone does NOT
// trigger joining — trailing-comma VALUE_ITEM lists are far more common than
// comma-wrapped continuations and must stay one item per line.
function joinContinuations(lines: ReadonlyArray<LogicalLine>): LogicalLine[] {
  const out: LogicalLine[] = [];
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1] : undefined;
    if (
      prev !== undefined &&
      line.cls !== 'BLANKISH' &&
      prev.cls !== 'BLANKISH' &&
      JOINABLE_PREV.has(prev.cls) &&
      JOINABLE_CUR.has(line.cls) &&
      !prev.forceEntity &&
      !line.forceEntity &&
      line.indent >= prev.indent &&
      prev.nLines < MAX_JOINED_LINES &&
      (bracketBalance(prev.body, true) > 0 || prev.body.endsWith('='))
    ) {
      prev.body += ' ' + line.body;
      prev.nLines += line.nLines;
      prev.cls = classifyBody(prev.body);
      continue;
    }
    out.push({...line});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property / name extraction helpers.
// ---------------------------------------------------------------------------

const HASH_BLOB_RE = /\{[0-9a-f]{5,16}[\s}]/;

// Splits an entity line into a clean name and a dim suffix: strips a leading
// bullet and trailing ':', and moves a "{a1b2c3 ...}" hash-blob (and
// everything after it) into the suffix.
function cleanName(t: string): {name: string; suffix: string} {
  let s = t.replace(/^[*+-]\s+/, '');
  if (s.endsWith(':')) s = s.substring(0, s.length - 1);
  const blob = HASH_BLOB_RE.exec(s);
  if (blob !== null && blob.index > 0) {
    return {
      name: s.substring(0, blob.index).trim(),
      suffix: s.substring(blob.index).trim(),
    };
  }
  return {name: s, suffix: ''};
}

// Single-property split for PROPERTY_COLON / PROPERTY_EQUALS / ARROW_MAP.
function parseProp(cls: LineClass, body: string): EntityProp {
  if (cls === 'PROPERTY_COLON') {
    const idx = body.indexOf(':');
    return {
      key: body.substring(0, idx).trim(),
      value: body.substring(idx + 1).trim(),
    };
  }
  if (cls === 'ARROW_MAP') {
    const m = / (?:->|=>|→) /u.exec(body);
    if (m !== null) {
      return {
        key: body.substring(0, m.index).trim(),
        value: body.substring(m.index + m[0].length).trim(),
      };
    }
  }
  // PROPERTY_EQUALS (rules a-d): split at the first '=', tolerating the
  // " = " spaced form and the empty-value form.
  const idx = body.indexOf('=');
  if (idx < 0) return {key: body, value: ''};
  return {
    key: body.substring(0, idx).trim(),
    value: body.substring(idx + 1).trim(),
  };
}

// Splits a KV_RUN / KV_COLON_RUN into N properties. Tokens that don't match
// the kv shape (the <=40% slack) are folded into the preceding value, so no
// content is lost.
function splitRun(cls: LineClass, body: string): EntityProp[] {
  const colon = cls === 'KV_COLON_RUN';
  const tokenRe = colon ? KVC_TOKEN_RE : KV_TOKEN_RE;
  const sep = colon ? ':' : '=';
  const props: EntityProp[] = [];
  for (const tok of body.split(/\s+/)) {
    if (tokenRe.test(tok)) {
      const idx = tok.indexOf(sep);
      let value = tok.substring(idx + 1);
      if (value.endsWith(',')) value = value.substring(0, value.length - 1);
      props.push({key: tok.substring(0, idx), value});
    } else if (props.length > 0) {
      const last = props[props.length - 1];
      props[props.length - 1] = {
        key: last.key,
        value: last.value === '' ? tok : `${last.value} ${tok}`,
      };
    } else {
      props.push({key: tok, value: ''});
    }
  }
  return props;
}

// ---------------------------------------------------------------------------
// Table / event grouping helpers.
// ---------------------------------------------------------------------------

const NUMERIC_CELL_RE = /^[\d.,%+-]*\d[\d.,%+-]*$/;

function splitPipeRow(body: string): string[] {
  const cells = body.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Column boundaries for aligned tables: the union of 2+-space gaps present
// in >= 80% of the rows (printf %Ns alignment).
function alignedRanges(bodies: ReadonlyArray<string>): Array<[number, number]> {
  const width = Math.max(...bodies.map((b) => b.length));
  const spaceCount = new Array<number>(width).fill(0);
  for (const b of bodies) {
    for (let p = 0; p < width; p++) {
      if (p >= b.length || b[p] === ' ') spaceCount[p]++;
    }
  }
  const thr = bodies.length * 0.8;
  const ranges: Array<[number, number]> = [];
  let segStart = -1;
  let p = 0;
  while (p < width) {
    if (spaceCount[p] >= thr) {
      let q = p;
      while (q < width && spaceCount[q] >= thr) q++;
      if (q - p >= 2) {
        if (segStart >= 0) ranges.push([segStart, p]);
        segStart = -1;
      } else if (segStart < 0) {
        segStart = p;
      }
      p = q;
    } else {
      if (segStart < 0) segStart = p;
      p++;
    }
  }
  if (segStart >= 0) ranges.push([segStart, width]);
  return ranges;
}

function buildTable(
  run: ReadonlyArray<LogicalLine>,
  pipe: boolean,
): EntityTable {
  const bodies = run.map((l) => l.body);
  let rows: string[][];
  if (pipe) {
    rows = bodies.map(splitPipeRow);
  } else {
    const ranges = alignedRanges(bodies);
    rows =
      ranges.length >= 2
        ? bodies.map((b) => ranges.map(([a, z]) => b.substring(a, z).trim()))
        : bodies.map((b) => b.split(/\s{2,}/));
  }
  const nCols = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) =>
    r.length === nCols
      ? r
      : r.concat(new Array<string>(nCols - r.length).fill('')),
  );
  // Header adoption: the first row is the column-header row when it has no
  // numeric cells while the second row has some.
  const numCells = (r: ReadonlyArray<string>) =>
    r.filter((c) => NUMERIC_CELL_RE.test(c)).length;
  let columns: string[];
  if (rows.length >= 2 && numCells(rows[0]) === 0 && numCells(rows[1]) > 0) {
    columns = rows[0];
    rows = rows.slice(1);
  } else {
    columns = new Array<string>(nCols).fill('').map((_, i) => `col${i + 1}`);
  }
  return {kind: 'table', columns, rows};
}

// Splits a TIMESTAMPED_EVENT body into [ts, message] (LocalLog " - msg" and
// EventLogger " msg" forms).
function parseEvent(body: string): [string, string] {
  const m = TS_RE.exec(body);
  if (m === null) return ['', body];
  const rest = body
    .substring(m[0].length)
    .replace(/^\s*-\s*/, '')
    .trim();
  return [m[0], rest];
}

// ---------------------------------------------------------------------------
// Layer 2, pass D: tree composition.
// ---------------------------------------------------------------------------

// Name of the synthetic entity grouping loose top-level property/text lines
// (e.g. the "Service host process PID: 1211" preamble).
const OVERVIEW_NAME = 'Overview';

// Classes that always open an entity node.
const RECORD_CLASSES = new Set<LineClass>([
  'SERVICE_HEADER',
  'RECORD_STAR',
  'RECORD_HASHN',
  'RECORD_ID',
  'RECORD_PAREN',
  'RECORD_BRACE',
  'BLOCK_OPEN',
  'HEADER_COLON',
]);

// Single-property classes (may still be promoted to a header entity when
// followed by deeper-indented lines, e.g. "Events log: audio lifecycle").
const PROP_CLASSES = new Set<LineClass>([
  'PROPERTY_COLON',
  'PROPERTY_EQUALS',
  'ARROW_MAP',
]);

// Indent-0 ALL-CAPS / "(dumpsys xyz)" headers scope until the next such
// header even though their children are also at indent 0.
function isCapsHeader(l: LogicalLine): boolean {
  if (l.indent !== 0) return false;
  if (l.cls !== 'HEADER_COLON' && l.cls !== 'BARE_LABEL' && l.cls !== 'PROSE') {
    return false;
  }
  if (/\(dumpsys [^)]+\):?$/.test(l.body)) return true;
  return l.body.length >= 6 && /^[A-Z]/.test(l.body) && !/[a-z]/.test(l.body);
}

interface StackEntry {
  readonly indent: number;
  readonly node: EntityNode;
  // Open brace-balance counter for DualDumpOutputStream/proto-text blocks.
  // While set, indentation is advisory only: lines attach inside the block
  // until the counter returns to zero.
  brace?: number;
  readonly caps?: boolean;
}

export function buildEntityTree(lines: ReadonlyArray<string>): EntityTree {
  const classified = lines.map(classifyLine);
  const unit = detectIndentUnit(classified);
  const resolved = resolveTreeDraw(classified, unit);
  const logical = joinContinuations(resolved);

  const counts: LineCounts = {
    entity: 0,
    property: 0,
    text: 0,
    table: 0,
    event: 0,
  };
  const nodes: EntityNode[] = [];

  function newEntity(
    name: string,
    suffix: string,
    parent: EntityNode,
    table?: EntityTable,
  ): EntityNode {
    const node: EntityNode = {
      id: nodes.length,
      parentId: parent.id,
      name,
      suffix,
      depth: parent.depth + 1,
      children: [],
      props: [],
      text: [],
      table,
    };
    nodes.push(node);
    parent.children.push(node);
    return node;
  }

  // A virtual super-root (id -1 semantics): real roots get parentId -1.
  const superRoot: EntityNode = {
    id: -1,
    parentId: -1,
    name: '',
    suffix: '',
    depth: -1,
    children: [],
    props: [],
    text: [],
  };

  // Loose top-level property/text lines are grouped under a synthetic
  // "Overview" entity, created lazily so it only appears when needed.
  let overview: EntityNode | undefined = undefined;
  function leafTarget(node: EntityNode): EntityNode {
    if (node !== superRoot) return node;
    if (overview === undefined) {
      overview = newEntity(OVERVIEW_NAME, '', superRoot);
      // Move it to the front of the root list.
      superRoot.children.pop();
      superRoot.children.unshift(overview);
    }
    return overview;
  }

  const stack: StackEntry[] = [{indent: -1, node: superRoot}];
  const top = () => stack[stack.length - 1];
  function popTo(indent: number): void {
    while (stack.length > 1 && top().indent >= indent) stack.pop();
  }

  // Attaches a leaf line (inside or outside brace blocks) by class.
  function attachLeaf(l: LogicalLine, node: EntityNode): void {
    const target = leafTarget(node);
    if (l.cls === 'KV_RUN' || l.cls === 'KV_COLON_RUN') {
      target.props.push(...splitRun(l.cls, l.body));
      counts.property += l.nLines;
    } else if (PROP_CLASSES.has(l.cls)) {
      target.props.push(parseProp(l.cls, l.body));
      counts.property += l.nLines;
    } else {
      target.text.push(l.body);
      counts.text += l.nLines;
    }
  }

  // Builds the entity node for a node-opening line, deriving name/suffix and
  // self-properties per class.
  function makeEntity(l: LogicalLine, parent: EntityNode): EntityNode {
    counts.entity += l.nLines;
    const body = l.body;
    switch (l.cls) {
      case 'RECORD_ID': {
        const m = /^([0-9a-f]{6,8}) +(.*)$/.exec(body);
        if (m !== null) return newEntity(m[2], m[1], parent);
        break;
      }
      case 'RECORD_BRACE': {
        const idx = body.indexOf('{');
        const ent = newEntity(
          body.substring(0, idx).trim(),
          body.substring(idx).trim(),
          parent,
        );
        // Balanced "Class{k=v ...}" leaf records: decompose an inner KV_RUN
        // payload into self-properties (Intent.toString et al).
        const inner = body.substring(idx + 1, body.lastIndexOf('}')).trim();
        if (inner !== '' && classifyBody(inner) === 'KV_RUN') {
          ent.props.push(...splitRun('KV_RUN', inner));
        }
        return ent;
      }
      case 'RECORD_PAREN': {
        const idx = body.indexOf('(');
        if (idx > 0) {
          return newEntity(body.substring(0, idx), body.substring(idx), parent);
        }
        break;
      }
      case 'BLOCK_OPEN':
        return newEntity(body.replace(/ ?=? ?[{[]$/, ''), '', parent);
      case 'KV_RUN':
      case 'KV_COLON_RUN': {
        const {name, suffix} = cleanName(body);
        const ent = newEntity(name, suffix, parent);
        ent.props.push(...splitRun(l.cls, body));
        return ent;
      }
      default:
        break;
    }
    if (PROP_CLASSES.has(l.cls)) {
      // Property promoted to header ("Events log: audio lifecycle" + deeper
      // children): named after the key, inline value kept as self-property.
      const prop = parseProp(l.cls, body);
      const ent = newEntity(prop.key, '', parent);
      if (prop.value !== '') ent.props.push(prop);
      return ent;
    }
    const {name, suffix} = cleanName(body);
    return newEntity(name, suffix, parent);
  }

  const n = logical.length;
  // nextIdx[i]: index of the next non-blank logical line after i, or -1.
  const nextIdx = new Array<number>(n).fill(-1);
  for (let i = n - 2, next = -1; i >= 0; i--) {
    next = logical[i + 1].cls === 'BLANKISH' ? nextIdx[i + 1] : i + 1;
    nextIdx[i] = next;
  }

  let i = 0;
  while (i < n) {
    const l = logical[i];
    if (l.cls === 'BLANKISH') {
      i++;
      continue;
    }

    // --- Brace-balanced block mode (DualDumpOutputStream / proto-text). ---
    const t = top();
    if (t.brace !== undefined) {
      const delta = bracketBalance(l.body, false);
      if (
        delta > 0 &&
        (l.cls === 'BLOCK_OPEN' ||
          l.cls === 'RECORD_BRACE' ||
          l.cls === 'RECORD_STAR')
      ) {
        // Nested block: gets its own balance counter.
        const ent = makeEntity(l, t.node);
        stack.push({indent: l.indent, node: ent, brace: delta});
      } else {
        attachLeaf(l, t.node);
        t.brace += delta;
        // A line returning the counter to <= 0 closes the block (possibly
        // several blocks at once, e.g. "}]").
        let entry: StackEntry | undefined = t;
        while (
          entry !== undefined &&
          entry.brace !== undefined &&
          entry.brace <= 0
        ) {
          const residual: number = entry.brace;
          stack.pop();
          entry = stack.length > 1 ? top() : undefined;
          if (entry?.brace !== undefined && residual < 0) {
            entry.brace += residual;
          }
        }
      }
      i++;
      continue;
    }

    // --- Table and event-run grouping. ---
    if (
      l.cls === 'TABLE_ROW_PIPE' ||
      l.cls === 'TABLE_ROW_ALIGNED' ||
      l.cls === 'TIMESTAMPED_EVENT'
    ) {
      let j = i + 1;
      while (
        j < n &&
        logical[j].cls === l.cls &&
        logical[j].indent === l.indent
      ) {
        j++;
      }
      if (j - i >= 2) {
        popTo(l.indent);
        const run = logical.slice(i, j);
        const nRaw = run.reduce((a, r) => a + r.nLines, 0);
        let ent: EntityNode;
        if (l.cls === 'TIMESTAMPED_EVENT') {
          const table: EntityTable = {
            kind: 'events',
            columns: ['Timestamp', 'Message'],
            rows: run.map((r) => parseEvent(r.body)),
          };
          ent = newEntity(`Events (${run.length})`, '', top().node, table);
          counts.event += nRaw;
        } else {
          const table = buildTable(run, l.cls === 'TABLE_ROW_PIPE');
          ent = newEntity(
            `Table (${table.rows.length} rows)`,
            '',
            top().node,
            table,
          );
          counts.table += nRaw;
        }
        stack.push({indent: l.indent, node: ent});
        i = j;
        continue;
      }
      // A lone row/event falls through and is attached as a leaf below.
    }

    // --- ALL-CAPS top-level section scoping. ---
    if (isCapsHeader(l)) {
      while (stack.length > 1) stack.pop();
      const body = l.body.endsWith(':')
        ? l.body.substring(0, l.body.length - 1)
        : l.body;
      counts.entity += l.nLines;
      const ent = newEntity(body, '', superRoot);
      // Effective indent -0.5: ordinary indent-0 lines nest inside; only the
      // next caps header (handled above) closes the scope.
      stack.push({indent: -0.5, node: ent, caps: true});
      i++;
      continue;
    }

    popTo(l.indent);
    const next = nextIdx[i];
    const hasDeeper = next >= 0 && logical[next].indent > l.indent;

    if (RECORD_CLASSES.has(l.cls)) {
      const balance =
        l.cls === 'RECORD_BRACE' ||
        l.cls === 'BLOCK_OPEN' ||
        l.cls === 'RECORD_STAR' ||
        l.cls === 'RECORD_HASHN'
          ? bracketBalance(l.body, false)
          : 0;
      const ent = makeEntity(l, top().node);
      stack.push({
        indent: l.indent,
        node: ent,
        brace: balance > 0 ? balance : undefined,
      });
    } else if (hasDeeper || l.forceEntity) {
      // Header adoption: any leaf-shaped line followed by deeper-indented
      // lines acts as a header (BARE_LABEL, properties, kv runs, prose...).
      const ent = makeEntity(l, top().node);
      stack.push({indent: l.indent, node: ent});
    } else {
      attachLeaf(l, top().node);
    }
    i++;
  }

  // Conservation check: every non-blank input line is attributed exactly
  // once across the five counters.
  const nonBlank = classified.filter((c) => c.cls !== 'BLANKISH').length;
  const total =
    counts.entity + counts.property + counts.text + counts.table + counts.event;
  console.assert(total === nonBlank, 'entity_tree conservation violated', {
    total,
    nonBlank,
    counts,
  });

  return {roots: superRoot.children, nodes, counts};
}
