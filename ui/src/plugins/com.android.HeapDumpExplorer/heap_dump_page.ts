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

import m from 'mithril';
import type {Engine} from '../../trace_processor/engine';
import type {Trace} from '../../public/trace';
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';
import {Tabs} from '../../widgets/tabs';
import type {TabsTab} from '../../widgets/tabs';
import type {NavState} from './nav_state';
import type {OverviewData} from './types';
import {nav, navigate, syncFromSubpage, setNavigateCallback} from './nav_state';
import * as queries from './queries';
import {SQL_PREAMBLE} from './components';
import OverviewView from './views/overview_view';
import DominatorsView from './views/dominators_view';
import ObjectView from './views/object_view';
import AllObjectsView from './views/all_objects_view';
import BitmapGalleryView from './views/bitmap_gallery_view';
import ClassesView from './views/classes_view';
import StringsView from './views/strings_view';
import ArraysView from './views/arrays_view';
import FlamegraphObjectsView, {
  flamegraphQuery,
} from './views/flamegraph_objects_view';
import {NUM} from '../../trace_processor/query_result';
import {
  baselineDumpFilterSql,
  dispose as disposeBaseline,
  getActiveBaseline,
  isDiffActive,
} from './baseline/state';
import {TopBar} from './top_bar';
import ClassesDiffView from './views/diff/classes_diff_view';
import StringsDiffView from './views/diff/strings_diff_view';
import ArraysDiffView from './views/diff/arrays_diff_view';
import BitmapsDiffView from './views/diff/bitmaps_diff_view';
import DominatorsDiffView from './views/diff/dominators_diff_view';

interface HeapdumpSelection {
  pathHashes: string;
  isDominator: boolean;
}

let nextFgId = 0;
const flamegraphTabs: Array<
  {id: number; count: number | null} & HeapdumpSelection
> = [];
let activeFgId = -1;

export function setFlamegraphSelection(
  sel: HeapdumpSelection,
  engine: Engine,
): void {
  const existing = flamegraphTabs.find(
    (t) => t.pathHashes === sel.pathHashes && t.isDominator === sel.isDominator,
  );
  if (existing) {
    activeFgId = existing.id;
    navigate('flamegraph-objects');
    return;
  }
  const id = nextFgId++;
  const tab = {id, count: null as number | null, ...sel};
  flamegraphTabs.push(tab);
  activeFgId = id;
  const q = flamegraphQuery(sel.pathHashes, sel.isDominator);
  engine
    .query(`${SQL_PREAMBLE}; SELECT COUNT(*) AS c FROM (${q})`)
    .then((r) => {
      tab.count = Number(r.firstRow({c: NUM}).c);
      m.redraw();
    });
}

export function resetFlamegraphSelection(): void {
  flamegraphTabs.length = 0;
  nextFgId = 0;
  activeFgId = -1;
}

// Overview cache keyed on (engine identity, filter SQL): two engines
// may share (upid, ts) values, and one engine serves several dumps
// over the page's lifetime.
const overviewCache = new Map<string, OverviewData>();
const overviewLoadingFor = new Set<string>();

let nextEngineUid = 1;
const engineUid = new WeakMap<Engine, number>();
function engineKey(engine: Engine, filterSql: string): string {
  let id = engineUid.get(engine);
  if (id === undefined) {
    id = nextEngineUid++;
    engineUid.set(engine, id);
  }
  return `${id}:${filterSql}`;
}

export function resetCachedOverview(): void {
  overviewCache.clear();
  overviewLoadingFor.clear();
}

function onDumpChanged(): void {
  resetCachedOverview();
  resetFlamegraphSelection();
  resetInstanceTabs();
  queries.resetBitmapDumpDataCache();
  if (nav.view === 'object' || nav.view === 'flamegraph-objects') {
    navigate('overview');
  }
}

interface InstanceTab {
  id: number;
  objId: number;
  label: string;
}

let nextInstanceTabId = 0;
const instanceTabs: InstanceTab[] = [];
let activeInstanceTabId = -1;

function instanceTabKey(id: number): string {
  return `inst-${id}`;
}

export function resetInstanceTabs(): void {
  instanceTabs.length = 0;
  nextInstanceTabId = 0;
  activeInstanceTabId = -1;
}

function openInstanceTab(objId: number, label?: string): void {
  const existing = instanceTabs.find((t) => t.objId === objId);
  if (existing) {
    activeInstanceTabId = existing.id;
    return;
  }
  const displayLabel = label ?? 'Instance';
  const tab: InstanceTab = {
    id: nextInstanceTabId++,
    objId,
    label:
      displayLabel.length > 30 ? displayLabel.slice(0, 30) + '…' : displayLabel,
  };
  instanceTabs.push(tab);
  activeInstanceTabId = tab.id;
}

function navigateWithTabs(
  view: NavState['view'],
  params?: Record<string, unknown>,
): void {
  if (view === 'object') {
    openInstanceTab(params?.id as number, params?.label as string | undefined);
    navigate(view, params);
    return;
  }
  activeInstanceTabId = -1;
  navigate(view, params);
}

function syncInstanceTabFromNav(): void {
  if (nav.view !== 'object') {
    activeInstanceTabId = -1;
    return;
  }
  const objId = nav.params.id;
  const existing = instanceTabs.find((t) => t.objId === objId);
  if (existing) {
    activeInstanceTabId = existing.id;
  } else {
    openInstanceTab(objId, nav.params.label);
  }
}

function fgTabKey(id: number): string {
  return `fg-${id}`;
}

function parseFgTabKey(key: string): number | undefined {
  if (!key.startsWith('fg-')) return undefined;
  return parseInt(key.slice(3), 10);
}

function getActiveTabKey(): string {
  if (nav.view === 'flamegraph-objects' && flamegraphTabs.length > 0) {
    const tab = flamegraphTabs.find((t) => t.id === activeFgId);
    return fgTabKey(
      tab ? tab.id : flamegraphTabs[flamegraphTabs.length - 1].id,
    );
  }
  if (activeInstanceTabId >= 0) {
    return instanceTabKey(activeInstanceTabId);
  }
  return nav.view;
}

function handleTabChange(key: string): void {
  const fgId = parseFgTabKey(key);
  if (fgId !== undefined) {
    activeFgId = fgId;
    navigate('flamegraph-objects');
  } else if (key.startsWith('inst-')) {
    activeInstanceTabId = parseInt(key.slice(5), 10);
    const tab = instanceTabs.find((t) => t.id === activeInstanceTabId);
    if (tab) {
      navigate('object', {id: tab.objId});
    }
  } else {
    activeFgId = -1;
    activeInstanceTabId = -1;
    navigate(key as NavState['view']);
  }
}

function handleTabClose(key: string): void {
  const fgId = parseFgTabKey(key);
  if (fgId !== undefined) {
    const idx = flamegraphTabs.findIndex((t) => t.id === fgId);
    if (idx === -1) return;
    flamegraphTabs.splice(idx, 1);
    if (activeFgId === fgId) {
      activeFgId = -1;
      navigate('overview');
    }
    return;
  }
  if (!key.startsWith('inst-')) return;
  const id = parseInt(key.slice(5), 10);
  const idx = instanceTabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  instanceTabs.splice(idx, 1);
  if (activeInstanceTabId === id) {
    activeInstanceTabId = -1;
    navigate('overview');
  }
}

function buildTabs(
  state: NavState,
  engine: Engine,
  overview: OverviewData,
  baselineOverview: OverviewData | undefined,
  baselineLoading: boolean,
): TabsTab[] {
  const trace = HeapDumpPage.trace;
  const diffActive = isDiffActive();
  const baselineEngine = getActiveBaseline()?.trace.engine;
  const tabs: TabsTab[] = [
    {
      key: 'overview',
      title: 'Overview',
      content: m(OverviewView, {
        overview,
        diffActive,
        baselineOverview: diffActive ? baselineOverview : undefined,
        baselineLoading: diffActive && baselineLoading,
        navigate: navigateWithTabs,
      }),
    },
    {
      key: 'classes',
      title: 'Classes',
      content:
        diffActive && baselineEngine
          ? m(ClassesDiffView, {
              currentEngine: engine,
              baselineEngine,
              navigate: navigateWithTabs,
            })
          : m(ClassesView, {
              engine,
              navigate: navigateWithTabs,
              initialRootClass:
                state.view === 'classes' ? state.params.rootClass : undefined,
            }),
    },
    {
      key: 'objects',
      title: 'Objects',
      content: m(AllObjectsView, {
        engine,
        navigate: navigateWithTabs,
        initialClass: state.view === 'objects' ? state.params.cls : undefined,
      }),
    },
    {
      key: 'dominators',
      title: 'Dominators',
      content:
        diffActive && baselineEngine
          ? m(DominatorsDiffView, {
              currentEngine: engine,
              baselineEngine,
              navigate: navigateWithTabs,
            })
          : m(DominatorsView, {engine, navigate: navigateWithTabs}),
    },
    {
      key: 'bitmaps',
      title: 'Bitmaps',
      content:
        diffActive && baselineEngine
          ? m(BitmapsDiffView, {
              currentEngine: engine,
              baselineEngine,
              navigate: navigateWithTabs,
            })
          : m(BitmapGalleryView, {
              engine,
              navigate: navigateWithTabs,
              hasFieldValues: overview.hasFieldValues,
              filterKey:
                state.view === 'bitmaps' ? state.params.filterKey : undefined,
            }),
    },
    {
      key: 'strings',
      title: 'Strings',
      content:
        diffActive && baselineEngine
          ? m(StringsDiffView, {
              currentEngine: engine,
              baselineEngine,
              navigate: navigateWithTabs,
            })
          : m(StringsView, {
              engine,
              navigate: navigateWithTabs,
              initialQuery:
                state.view === 'strings' ? state.params.q : undefined,
              hasFieldValues: overview.hasFieldValues,
            }),
    },
    {
      key: 'arrays',
      title: 'Arrays',
      content:
        diffActive && baselineEngine
          ? m(ArraysDiffView, {
              currentEngine: engine,
              baselineEngine,
              navigate: navigateWithTabs,
            })
          : m(ArraysView, {
              engine,
              navigate: navigateWithTabs,
              initialArrayHash:
                state.view === 'arrays' ? state.params.arrayHash : undefined,
              hasFieldValues: overview.hasFieldValues,
            }),
    },
  ];

  for (const fg of flamegraphTabs) {
    tabs.push({
      key: fgTabKey(fg.id),
      title:
        fg.count !== null
          ? `Flamegraph (${fg.count.toLocaleString()})`
          : 'Flamegraph',
      closeButton: true,
      content: m(FlamegraphObjectsView, {
        engine,
        navigate: navigateWithTabs,
        pathHashes: fg.pathHashes,
        isDominator: fg.isDominator,
        onBackToTimeline: () => {
          if (trace) trace.navigate('#!/viewer');
        },
      }),
    });
  }

  for (const obj of instanceTabs) {
    tabs.push({
      key: instanceTabKey(obj.id),
      title: obj.label,
      closeButton: true,
      content: m(ObjectView, {
        engine,
        heaps: overview.heaps,
        navigate: navigateWithTabs,
        params: {id: obj.objId},
      }),
    });
  }

  return tabs;
}

interface HeapDumpPageAttrs {
  readonly subpage: string | undefined;
}

export class HeapDumpPage implements m.ClassComponent<HeapDumpPageAttrs> {
  static engine: Engine | null = null;
  static trace: Trace | null = null;
  static hasHeapData = false;

  oncreate(vnode: m.VnodeDOM<HeapDumpPageAttrs>) {
    setNavigateCallback((subpage) => {
      const href = `#!/heapdump${subpage ? '/' + subpage : ''}`;
      window.location.hash = href.slice(1);
    });
    syncFromSubpage(vnode.attrs.subpage);
    this.kickOverviewLoadFor(
      this.activeOverviewEngine(),
      queries.dumpFilterSql('o'),
    );
  }

  onremove() {
    setNavigateCallback(undefined);
  }

  /**
   * Engine the Overview / non-diff tabs query. In Baseline-only mode this
   * is the baseline engine; otherwise the primary trace's engine. Diff
   * views do their own dual-engine fan-out.
   */
  private activeOverviewEngine(): Engine | null {
    if (!HeapDumpPage.engine) return null;
    return HeapDumpPage.engine;
  }

  private kickOverviewLoadFor(engine: Engine | null, filterSql: string): void {
    if (!engine) return;
    const key = engineKey(engine, filterSql);
    if (overviewCache.has(key) || overviewLoadingFor.has(key)) return;
    overviewLoadingFor.add(key);
    queries
      .getOverview(engine, filterSql)
      .then((data) => {
        overviewCache.set(key, data);
      })
      .catch((err) => {
        console.error('Failed to load overview:', err);
      })
      .finally(() => {
        overviewLoadingFor.delete(key);
        m.redraw();
      });
  }

  view(vnode: m.Vnode<HeapDumpPageAttrs>) {
    syncFromSubpage(vnode.attrs.subpage);
    syncInstanceTabFromNav();

    if (!HeapDumpPage.engine || !HeapDumpPage.hasHeapData) {
      return m(
        'div',
        {class: 'ah-page'},
        m(EmptyState, {
          icon: 'memory',
          title: 'No heap graph data in this trace',
          fillHeight: true,
        }),
      );
    }

    const trace = HeapDumpPage.trace;
    const topBar = trace ? m(TopBar, {trace, onDumpChanged}) : null;

    const overviewEngine = this.activeOverviewEngine()!;
    const primaryFilter = queries.dumpFilterSql('o');
    this.kickOverviewLoadFor(overviewEngine, primaryFilter);
    const overview = overviewCache.get(
      engineKey(overviewEngine, primaryFilter),
    );

    // Diff mode: also pre-load the baseline engine's overview. Use the
    // baseline filter — the primary's (upid, ts) values don't exist in
    // the baseline engine.
    const baseline = getActiveBaseline();
    const baselineEngine = baseline?.trace.engine ?? null;
    const baselineFilter = baselineDumpFilterSql('o');
    if (baselineEngine) {
      this.kickOverviewLoadFor(baselineEngine, baselineFilter);
    }
    const baselineCacheKey =
      baselineEngine !== null
        ? engineKey(baselineEngine, baselineFilter)
        : null;
    const baselineOverview =
      baselineCacheKey !== null
        ? overviewCache.get(baselineCacheKey)
        : undefined;
    const baselineLoading =
      baselineCacheKey !== null &&
      baselineOverview === undefined &&
      overviewLoadingFor.has(baselineCacheKey);

    if (!overview) {
      return m(
        'div',
        {class: 'ah-page'},
        topBar,
        m('div', {class: 'ah-loading'}, m(Spinner, {easing: true})),
      );
    }

    // Key the Tabs widget on (primary dump, baseline dump) so a change
    // in either remounts every tab.
    const active = queries.getActiveDump();
    const primaryKey = active ? `${active.upid}:${active.ts}` : 'none';
    const baselineKey = baseline
      ? `${baseline.trace.id}:${baseline.dump.upid}:${baseline.dump.ts}`
      : 'none';
    const tabsKey = `${primaryKey}|${baselineKey}`;

    return m(
      'div',
      {class: 'ah-page'},
      topBar,
      m(
        'main',
        {class: 'ah-main'},
        m(Tabs, {
          key: tabsKey,
          tabs: buildTabs(
            nav,
            overviewEngine,
            overview,
            baselineOverview,
            baselineLoading,
          ),
          activeTabKey: getActiveTabKey(),
          onTabChange: handleTabChange,
          onTabClose: handleTabClose,
        }),
      ),
    );
  }
}

/** Re-exported convenience for index.ts so it can dispose on trace change. */
export {disposeBaseline};
