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

// Shared state + data loading for the Bugreport Explorer, owned by the plugin
// and consumed by the full-screen page. Holds the section/service list (from
// the android_dumpstate table), the current selection, the per-selection line
// cache, the filter strings and the view mode, so they persist while the user
// navigates away from the page and back.

import m from 'mithril';
import type {Trace} from '../../public/trace';
import {sqliteString} from '../../base/string_utils';
import {
  LONG_NULL,
  NUM,
  STR,
  STR_NULL,
} from '../../trace_processor/query_result';

// One (section, service) pair from android_dumpstate. `section` is undefined
// for the dumpstate preamble (lines before the first section marker);
// `service` is only set within DUMPSYS sections.
export interface SectionEntry {
  readonly section: string | undefined;
  readonly service: string | undefined;
  readonly lineCount: number;
}

export interface BugreportSelection {
  readonly section: string | undefined;
  readonly service: string | undefined;
}

export type ViewMode = 'structured' | 'raw';

function cacheKey(sel: BugreportSelection): string {
  return `${sel.section ?? '\0'}${sel.service ?? '\0'}`;
}

export function selectionsEqual(
  a: BugreportSelection | undefined,
  b: BugreportSelection | undefined,
): boolean {
  return a?.section === b?.section && a?.service === b?.service;
}

export class BugreportExplorerSession {
  private _entries: ReadonlyArray<SectionEntry> = [];
  private readonly lineCache = new Map<string, ReadonlyArray<string>>();
  private _selection?: BugreportSelection;
  private _loading = false;
  private loadToken = 0;

  // Android SDK version of the device the bugreport was taken on (0 if
  // unknown). Renderers can use it to adapt to format changes across releases.
  sdkVersion = 0;

  // Search box over the left-hand section/service list.
  listFilter = '';
  // In-section filter over the lines of the current selection.
  lineFilter = '';
  viewMode: ViewMode = 'structured';

  constructor(readonly trace: Trace) {}

  get entries(): ReadonlyArray<SectionEntry> {
    return this._entries;
  }

  get selection(): BugreportSelection | undefined {
    return this._selection;
  }

  get loading(): boolean {
    return this._loading;
  }

  async init(): Promise<void> {
    const res = await this.trace.engine.query(`
      SELECT section, service, count(*) AS lines
      FROM android_dumpstate
      GROUP BY section, service
      ORDER BY section, service
    `);
    const entries: SectionEntry[] = [];
    for (
      const it = res.iter({section: STR_NULL, service: STR_NULL, lines: NUM});
      it.valid();
      it.next()
    ) {
      entries.push({
        section: it.section ?? undefined,
        service: it.service ?? undefined,
        lineCount: it.lines,
      });
    }
    this._entries = entries;

    const sdk = await this.trace.engine.query(`
      SELECT int_value AS v FROM metadata WHERE name = 'android_sdk_version'
    `);
    this.sdkVersion = Number(sdk.maybeFirstRow({v: LONG_NULL})?.v ?? 0);
  }

  select(sel: BugreportSelection): void {
    if (selectionsEqual(this._selection, sel)) return;
    this._selection = sel;
    this.lineFilter = '';
    void this.loadLines(sel);
  }

  // The cached lines for the current selection, or undefined while loading.
  get selectedLines(): ReadonlyArray<string> | undefined {
    if (this._selection === undefined) return undefined;
    return this.lineCache.get(cacheKey(this._selection));
  }

  // The list entry matching the current selection (for the line count).
  get selectedEntry(): SectionEntry | undefined {
    const sel = this._selection;
    if (sel === undefined) return undefined;
    return this._entries.find((e) => selectionsEqual(e, sel));
  }

  // Loads (and caches) the raw lines of one (section, service) pair. `IS` is
  // used instead of `=` so that NULL section (the preamble) and NULL service
  // (non-dumpsys sections) match.
  async loadLines(sel: BugreportSelection): Promise<void> {
    const key = cacheKey(sel);
    if (this.lineCache.has(key)) return;
    const token = ++this.loadToken;
    this._loading = true;
    try {
      const section =
        sel.section === undefined ? 'NULL' : sqliteString(sel.section);
      const service =
        sel.service === undefined ? 'NULL' : sqliteString(sel.service);
      const res = await this.trace.engine.query(`
        SELECT line
        FROM android_dumpstate
        WHERE section IS ${section} AND service IS ${service}
        ORDER BY id
      `);
      const lines: string[] = [];
      for (const it = res.iter({line: STR}); it.valid(); it.next()) {
        lines.push(it.line);
      }
      this.lineCache.set(key, lines);
    } finally {
      if (token === this.loadToken) this._loading = false;
      m.redraw();
    }
  }
}
