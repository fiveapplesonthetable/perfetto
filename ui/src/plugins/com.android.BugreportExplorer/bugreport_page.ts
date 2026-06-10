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

// The full-screen Bugreport Explorer page: a searchable section/service list
// on the left, and the selected section's content on the right, either
// structured (via the renderer registry) or as raw monospace lines.

import m from 'mithril';
import {Icons} from '../../base/semantic_icons';
import {Button, ButtonGroup} from '../../widgets/button';
import {DetailsShell} from '../../widgets/details_shell';
import {EmptyState} from '../../widgets/empty_state';
import {Menu, MenuItem, MenuTitle} from '../../widgets/menu';
import {Spinner} from '../../widgets/spinner';
import {TextInput} from '../../widgets/text_input';
import {findRenderer} from './renderers/registry';
import type {
  BugreportExplorerSession,
  BugreportSelection,
  SectionEntry,
} from './session';
import {selectionsEqual} from './session';

// Raw mode renders at most this many lines (sections are usually far below).
const MAX_RAW_LINES = 5000;

const PREAMBLE_LABEL = 'Header';

export interface BugreportPageAttrs {
  readonly session: BugreportExplorerSession;
}

// One left-pane group: a dumpstate section, with its dumpsys services nested
// underneath (only DUMPSYS* sections have services).
interface SectionGroup {
  readonly section: string | undefined;
  readonly label: string;
  // The section's own (service-less) entry, if any.
  readonly own?: SectionEntry;
  readonly services: ReadonlyArray<SectionEntry>;
}

// "DUMPSYS CRITICAL (/system/bin/dumpsys)" -> "DUMPSYS CRITICAL".
function sectionLabel(section: string | undefined): string {
  if (section === undefined) return PREAMBLE_LABEL;
  const paren = section.indexOf(' (');
  return paren > 0 ? section.substring(0, paren) : section;
}

// Auxiliary files from the bugreport zip (FS/..., dumpstate_log.txt, ...)
// are ingested with section = file path. They are listed under a separate
// collapsed "Files" group so they don't drown out the dumpstate sections.
function isFileSection(section: string | undefined): boolean {
  if (section === undefined) return false;
  const label = sectionLabel(section);
  return label.includes('/') || label.endsWith('.txt');
}

interface GroupedSections {
  readonly sections: SectionGroup[];
  readonly files: SectionGroup[];
}

function buildGroups(entries: ReadonlyArray<SectionEntry>): GroupedSections {
  const bySection = new Map<string | undefined, SectionEntry[]>();
  for (const e of entries) {
    let list = bySection.get(e.section);
    if (list === undefined) {
      list = [];
      bySection.set(e.section, list);
    }
    list.push(e);
  }
  const sections: SectionGroup[] = [];
  const files: SectionGroup[] = [];
  for (const [section, list] of bySection) {
    const group = {
      section,
      label: sectionLabel(section),
      own: list.find((e) => e.service === undefined),
      services: list.filter((e) => e.service !== undefined),
    };
    (isFileSection(section) ? files : sections).push(group);
  }
  // The preamble (NULL section) first, then alphabetical.
  const bySectionName = (a: SectionGroup, b: SectionGroup) => {
    if (a.section === undefined) return -1;
    if (b.section === undefined) return 1;
    return a.section.localeCompare(b.section);
  };
  sections.sort(bySectionName);
  files.sort(bySectionName);
  return {sections, files};
}

// "meminfo" + 1234 -> "meminfo (1,234)". MenuItem has no end-aligned value
// slot, so line counts are folded into the label.
function entryLabel(name: string, lineCount: number): string {
  return `${name} (${lineCount.toLocaleString()})`;
}

// Applies the left-pane search: a group matches if its label does (keeping
// all services), otherwise it is narrowed down to its matching services.
function filterGroups(
  groups: ReadonlyArray<SectionGroup>,
  query: string,
): SectionGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...groups];
  const out: SectionGroup[] = [];
  for (const g of groups) {
    if (g.label.toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const services = g.services.filter((s) =>
      (s.service ?? '').toLowerCase().includes(q),
    );
    if (services.length > 0) {
      out.push({...g, services});
    }
  }
  return out;
}

export class BugreportPage implements m.ClassComponent<BugreportPageAttrs> {
  // Cached left-pane groups (entries never change after init).
  private groups?: GroupedSections;
  // The auxiliary-files group is collapsed by default; searching auto-shows
  // matching files.
  private filesExpanded = false;

  // Memoized in-section line filtering, keyed on (lines identity, query), so
  // renderers receive a stable array identity per redraw and can cache their
  // parses.
  private filterSrc?: ReadonlyArray<string>;
  private filterQuery = '';
  private filterResult?: ReadonlyArray<string>;

  private filteredLines(
    lines: ReadonlyArray<string>,
    query: string,
  ): ReadonlyArray<string> {
    if (this.filterSrc !== lines || this.filterQuery !== query) {
      this.filterSrc = lines;
      this.filterQuery = query;
      const q = query.trim().toLowerCase();
      this.filterResult =
        q === '' ? lines : lines.filter((l) => l.toLowerCase().includes(q));
    }
    return this.filterResult ?? lines;
  }

  view({attrs}: m.CVnode<BugreportPageAttrs>): m.Children {
    const {session} = attrs;
    this.groups ??= buildGroups(session.entries);
    return m(
      '.pf-bre-page',
      this.renderSidebar(session),
      this.renderMain(session),
    );
  }

  private renderSidebar(session: BugreportExplorerSession): m.Children {
    const groups = filterGroups(
      this.groups?.sections ?? [],
      session.listFilter,
    );
    const fileGroups = filterGroups(
      this.groups?.files ?? [],
      session.listFilter,
    );
    const searching = session.listFilter.trim() !== '';
    const showFiles = this.filesExpanded || searching;
    return m('.pf-bre-sidebar', [
      m(
        '.pf-bre-sidebar__search',
        m(TextInput, {
          placeholder: 'Filter sections…',
          leftIcon: Icons.Search,
          value: session.listFilter,
          onInput: (value: string) => {
            session.listFilter = value;
          },
        }),
      ),
      m(
        '.pf-bre-sidebar__list',
        groups.length === 0 && fileGroups.length === 0
          ? m(EmptyState, {icon: 'search_off', title: 'No matching sections'})
          : m(Menu, [
              groups.map((g) => this.renderGroup(session, g)),
              fileGroups.length > 0 &&
                m(MenuItem, {
                  label: `Files (${fileGroups.length})`,
                  icon: showFiles ? Icons.ExpandDown : Icons.GoForward,
                  onclick: () => {
                    this.filesExpanded = !this.filesExpanded;
                  },
                }),
              showFiles && fileGroups.map((g) => this.renderGroup(session, g)),
            ]),
      ),
    ]);
  }

  private renderGroup(
    session: BugreportExplorerSession,
    group: SectionGroup,
  ): m.Children {
    const rows: m.Children[] = [];
    if (group.own !== undefined) {
      const ownSel: BugreportSelection = {
        section: group.section,
        service: undefined,
      };
      rows.push(
        m(MenuItem, {
          label: entryLabel(group.label, group.own.lineCount),
          title: group.section,
          active: selectionsEqual(session.selection, ownSel),
          onclick: () => session.select(ownSel),
        }),
      );
    } else {
      // Section with no own lines (e.g. DUMPSYS): non-clickable heading for
      // the service entries below.
      rows.push(m(MenuTitle, {label: group.label}));
    }
    for (const svc of group.services) {
      const sel: BugreportSelection = {
        section: group.section,
        service: svc.service,
      };
      rows.push(
        m(MenuItem, {
          label: entryLabel(svc.service ?? '', svc.lineCount),
          icon: 'subdirectory_arrow_right',
          active: selectionsEqual(session.selection, sel),
          onclick: () => session.select(sel),
        }),
      );
    }
    return rows;
  }

  private renderMain(session: BugreportExplorerSession): m.Children {
    const sel = session.selection;
    if (sel === undefined) {
      return m(
        '.pf-bre-main',
        m(EmptyState, {
          icon: 'bug_report',
          title: 'Select a bugreport section',
          fillHeight: true,
        }),
      );
    }
    const title =
      sel.service !== undefined
        ? `${sectionLabel(sel.section)} › ${sel.service}`
        : sectionLabel(sel.section);
    const lineCount = session.selectedEntry?.lineCount;
    return m(
      '.pf-bre-main',
      m(
        DetailsShell,
        {
          title: m('span', {title: sel.section}, title),
          description:
            lineCount !== undefined
              ? `${lineCount.toLocaleString()} lines`
              : undefined,
          fillHeight: true,
          buttons: [
            m(
              ButtonGroup,
              m(Button, {
                label: 'Structured',
                icon: 'account_tree',
                active: session.viewMode === 'structured',
                onclick: () => {
                  session.viewMode = 'structured';
                },
              }),
              m(Button, {
                label: 'Raw',
                icon: 'notes',
                active: session.viewMode === 'raw',
                onclick: () => {
                  session.viewMode = 'raw';
                },
              }),
            ),
            m(TextInput, {
              placeholder: 'Filter lines…',
              leftIcon: Icons.Filter,
              value: session.lineFilter,
              onInput: (value: string) => {
                session.lineFilter = value;
              },
            }),
          ],
        },
        this.renderContent(session, sel),
      ),
    );
  }

  private renderContent(
    session: BugreportExplorerSession,
    sel: BugreportSelection,
  ): m.Children {
    const lines = session.selectedLines;
    if (lines === undefined) {
      return m('.pf-bre-loading', m(Spinner, {easing: true}));
    }
    const filtered = this.filteredLines(lines, session.lineFilter);
    // The inner div is keyed by selection + view mode so widget state (tree
    // expansion, grid sort/filter) doesn't leak between sections.
    const key =
      `${sel.section ?? ''}\0${sel.service ?? ''}\0` + session.viewMode;
    if (session.viewMode === 'raw') {
      return m(
        '.pf-bre-content',
        m('.pf-bre-content__inner', {key}, this.renderRaw(filtered)),
      );
    }
    const renderer = findRenderer(
      {section: sel.section ?? '', service: sel.service},
      session.sdkVersion,
    );
    return m(
      '.pf-bre-content',
      m(
        '.pf-bre-content__inner',
        {key},
        renderer.render(filtered, {
          trace: session.trace,
          selection: {section: sel.section ?? '', service: sel.service},
          sdkVersion: session.sdkVersion,
        }),
      ),
    );
  }

  private renderRaw(lines: ReadonlyArray<string>): m.Children {
    const shown = lines.slice(0, MAX_RAW_LINES);
    return m('.pf-bre-raw', [
      shown.map((l) => m('.pf-bre-raw__line', l === '' ? ' ' : l)),
      lines.length > MAX_RAW_LINES &&
        m(
          '.pf-bre-truncation-note',
          `Showing first ${MAX_RAW_LINES.toLocaleString()} of ` +
            `${lines.length.toLocaleString()} lines. Use the filter to ` +
            'narrow down.',
        ),
    ]);
  }
}
