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
interface HeapdumpSelection {
  pathHashes: string;
  isDominator: boolean;
}
import type {NavState} from './nav_state';
import type {OverviewData} from './types';
import {nav, navigate, syncFromSubpage, setNavigateCallback} from './nav_state';
import * as queries from './queries';
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
import {SQL_PREAMBLE} from './components';
import {NUM} from '../../trace_processor/query_result';
import {
  dispose as disposeBaseline,
  getMode,
  getSession,
  isDiffActive,
} from './baseline/state';
import {HeapDumpDiffHeader} from './header';
import ClassesDiffView from './views/diff/classes_diff_view';
import StringsDiffView from './views/diff/strings_diff_view';
import ArraysDiffView from './views/diff/arrays_diff_view';
import BitmapsDiffView from './views/diff/bitmaps_diff_view';
import DominatorsDiffView from './views/diff/dominators_diff_view';

// Each "Open in Heapdump Explorer" creates a closable flamegraph tab.
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

// Per-engine overview cache. Survives component remounts (e.g. theme toggle).
// Keyed by Engine so the baseline engine gets its own cached overview when
// the user flips into "Baseline only" mode without re-querying.
const overviewByEngine: Map<Engine, OverviewData> = new Map();
const overviewLoadingFor: Set<Engine> = new Set();

/** Reset all cached overviews on primary trace change. */
export function resetCachedOverview(): void {
  overviewByEngine.clear();
  overviewLoadingFor.clear();
}

/** Drop cached overview for a specific engine (used on baseline disposal). */
export function dropOverviewFor(engine: Engine): void {
  overviewByEngine.delete(engine);
  overviewLoadingFor.delete(engine);
}

// Closable object tabs — clicking an object anywhere opens a new tab.
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
      displayLabel.length > 30
        ? displayLabel.slice(0, 30) + '\u2026'
        : displayLabel,
  };
  instanceTabs.push(tab);
  activeInstanceTabId = tab.id;
}

// Navigate wrapper: intercepts 'object' to open closable instance tabs.
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

// When nav state points to 'object' (e.g. after browser back), ensure
// the matching instance tab exists and is active. When nav moves away
// from 'object', clear the active instance tab so fixed tabs are shown.
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
  const session = getSession();
  const diffActive = isDiffActive();
  const baselineEngine = session?.engine;
  const raf = trace?.raf;
  const tabs: TabsTab[] = [
    {
      key: 'overview',
      title: 'Overview',
      content: m(OverviewView, {
        overview,
        baselineOverview: diffActive ? baselineOverview : undefined,
        baselineLoading: diffActive && baselineLoading,
        navigate: navigateWithTabs,
        raf: raf!,
      }),
    },
    {
      key: 'classes',
      title: 'Classes',
      content: diffActive && baselineEngine
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
      content: diffActive && baselineEngine
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
      content: diffActive && baselineEngine
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
      content: diffActive && baselineEngine
        ? m(StringsDiffView, {
            currentEngine: engine,
            baselineEngine,
            navigate: navigateWithTabs,
          })
        : m(StringsView, {
            engine,
            navigate: navigateWithTabs,
            initialQuery: state.view === 'strings' ? state.params.q : undefined,
            hasFieldValues: overview.hasFieldValues,
          }),
    },
    {
      key: 'arrays',
      title: 'Arrays',
      content: diffActive && baselineEngine
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

  // Append closable flamegraph tabs.
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

  // Append closable object instance tabs.
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
    this.kickOverviewLoadFor(this.activeOverviewEngine());
  }

  onremove() {
    setNavigateCallback(undefined);
  }

  /**
   * Which engine the Overview tab and other current/baseline-only modes
   * should query. In Diff mode this is still the current engine — the
   * diff views handle the dual-engine fan-out themselves.
   */
  private activeOverviewEngine(): Engine | null {
    if (!HeapDumpPage.engine) return null;
    const session = getSession();
    if (session !== null && getMode() === 'baseline') {
      return session.engine;
    }
    return HeapDumpPage.engine;
  }

  private kickOverviewLoadFor(engine: Engine | null): void {
    if (!engine) return;
    if (overviewByEngine.has(engine) || overviewLoadingFor.has(engine)) return;
    overviewLoadingFor.add(engine);
    queries
      .getOverview(engine)
      .then((data) => {
        overviewByEngine.set(engine, data);
      })
      .catch((err) => {
        console.error('Failed to load overview:', err);
      })
      .finally(() => {
        overviewLoadingFor.delete(engine);
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

    const overviewEngine = this.activeOverviewEngine();
    if (!overviewEngine) {
      return m(
        'div',
        {class: 'ah-page'},
        m('div', {class: 'ah-loading'}, m(Spinner, {easing: true})),
      );
    }
    // If we just flipped to a baseline whose overview hasn't been computed
    // yet, kick it off now (cheap if already loading/loaded).
    this.kickOverviewLoadFor(overviewEngine);
    const overview = overviewByEngine.get(overviewEngine);

    const trace = HeapDumpPage.trace;
    const header = trace ? m(HeapDumpDiffHeader) : null;

    // In diff mode, eagerly load the baseline engine's overview too so the
    // unified OverviewView can render side-by-side cards.
    const session = getSession();
    if (session !== null) {
      this.kickOverviewLoadFor(session.engine);
    }
    const baselineOverview =
      session !== null ? overviewByEngine.get(session.engine) : undefined;
    const baselineLoading =
      session !== null &&
      baselineOverview === undefined &&
      overviewLoadingFor.has(session.engine);

    if (!overview) {
      return m(
        'div',
        {class: 'ah-page'},
        header,
        m('div', {class: 'ah-loading'}, m(Spinner, {easing: true})),
      );
    }

    // The engine the non-diff tabs should use. In Diff mode, current is the
    // primary trace's engine. In Baseline-only mode, all tabs read from the
    // baseline engine instead.
    const tabEngine = overviewEngine;

    return m(
      'div',
      {class: 'ah-page'},
      header,
      m(
        'main',
        {class: 'ah-main'},
        m(Tabs, {
          tabs: buildTabs(
            nav,
            tabEngine,
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
