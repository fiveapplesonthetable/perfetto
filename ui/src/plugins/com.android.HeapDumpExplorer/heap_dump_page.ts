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
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';
import {Tabs} from '../../widgets/tabs';
import type {TabsTab} from '../../widgets/tabs';
import type {NavState, NavView} from './nav_state';
import type {HeapDumpExplorerSession} from './session';
import type {OverviewData} from './types';
import OverviewView from './views/overview_view';
import DominatorsView from './views/dominators_view';
import ObjectView from './views/object_view';
import AllObjectsView from './views/all_objects_view';
import BitmapGalleryView from './views/bitmap_gallery_view';
import ClassesView from './views/classes_view';
import StringsView from './views/strings_view';
import ArraysView from './views/arrays_view';
import FlamegraphObjectsView from './views/flamegraph_objects_view';

interface HeapDumpPageAttrs {
  /** Session for the currently-loaded trace, or null if none loaded yet. */
  readonly session: HeapDumpExplorerSession | null;
  /** Subpage portion of the URL hash, passed by the page router. */
  readonly subpage: string | undefined;
}

const FG_KEY_PREFIX = 'fg-';
const INSTANCE_KEY_PREFIX = 'inst-';

function fgTabKey(id: number): string {
  return `${FG_KEY_PREFIX}${id}`;
}

function instanceTabKey(id: number): string {
  return `${INSTANCE_KEY_PREFIX}${id}`;
}

/**
 * Returns the parsed flamegraph tab id when `key` is a flamegraph tab
 * key, or undefined for any other key.
 */
function parseFgTabKey(key: string): number | undefined {
  if (!key.startsWith(FG_KEY_PREFIX)) return undefined;
  return parseInt(key.slice(FG_KEY_PREFIX.length), 10);
}

/**
 * Returns the parsed instance tab id when `key` is an instance tab
 * key, or undefined for any other key.
 */
function parseInstanceTabKey(key: string): number | undefined {
  if (!key.startsWith(INSTANCE_KEY_PREFIX)) return undefined;
  return parseInt(key.slice(INSTANCE_KEY_PREFIX.length), 10);
}

/** Computes the `activeTabKey` to hand to the Tabs widget. */
function activeTabKey(session: HeapDumpExplorerSession): string {
  const tabs = session.flamegraphTabs;
  if (session.nav.view === 'flamegraph-objects' && tabs.length > 0) {
    const active = tabs.find((t) => t.id === session.activeFlamegraphId);
    return fgTabKey(active ? active.id : tabs[tabs.length - 1].id);
  }
  if (session.activeInstanceId >= 0) {
    return instanceTabKey(session.activeInstanceId);
  }
  return session.nav.view;
}

/**
 * Click on a tab header — dispatches to flamegraph / instance / fixed
 * tab semantics, all of which mutate the session, not module state.
 */
function handleTabChange(session: HeapDumpExplorerSession, key: string): void {
  const fgId = parseFgTabKey(key);
  if (fgId !== undefined) {
    session.setActiveFlamegraphId(fgId);
    session.navigate('flamegraph-objects');
    return;
  }
  const instanceId = parseInstanceTabKey(key);
  if (instanceId !== undefined) {
    session.setActiveInstanceId(instanceId);
    const tab = session.instanceTabs.find((t) => t.id === instanceId);
    if (tab) session.navigate('object', {id: tab.objId});
    return;
  }
  session.setActiveFlamegraphId(-1);
  session.setActiveInstanceId(-1);
  session.navigate(key as NavView);
}

/** Click on a tab's close button — only valid for closable tabs. */
function handleTabClose(session: HeapDumpExplorerSession, key: string): void {
  const fgId = parseFgTabKey(key);
  if (fgId !== undefined) {
    session.closeFlamegraph(fgId);
    return;
  }
  const instanceId = parseInstanceTabKey(key);
  if (instanceId !== undefined) {
    session.closeInstanceTab(instanceId);
  }
}

/**
 * Build the full ordered tab list (fixed tabs, then closable
 * flamegraph tabs, then closable instance tabs).
 */
function buildTabs(
  session: HeapDumpExplorerSession,
  state: NavState,
  overview: OverviewData,
): TabsTab[] {
  const {engine, trace, navigateWithTabs} = {
    engine: session.engine,
    trace: session.trace,
    navigateWithTabs: session.navigateWithTabs,
  };
  const tabs: TabsTab[] = [
    {
      key: 'overview',
      title: 'Overview',
      content: m(OverviewView, {overview, navigate: navigateWithTabs}),
    },
    {
      key: 'classes',
      title: 'Classes',
      content: m(ClassesView, {
        engine,
        navigate: navigateWithTabs,
        clearNavParam: session.clearNavParam,
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
        clearNavParam: session.clearNavParam,
        initialClass: state.view === 'objects' ? state.params.cls : undefined,
      }),
    },
    {
      key: 'dominators',
      title: 'Dominators',
      content: m(DominatorsView, {engine, navigate: navigateWithTabs}),
    },
    {
      key: 'bitmaps',
      title: 'Bitmaps',
      content: m(BitmapGalleryView, {
        engine,
        navigate: navigateWithTabs,
        clearNavParam: session.clearNavParam,
        hasFieldValues: overview.hasFieldValues,
        filterKey:
          state.view === 'bitmaps' ? state.params.filterKey : undefined,
      }),
    },
    {
      key: 'strings',
      title: 'Strings',
      content: m(StringsView, {
        engine,
        navigate: navigateWithTabs,
        clearNavParam: session.clearNavParam,
        initialQuery: state.view === 'strings' ? state.params.q : undefined,
        hasFieldValues: overview.hasFieldValues,
      }),
    },
    {
      key: 'arrays',
      title: 'Arrays',
      content: m(ArraysView, {
        engine,
        navigate: navigateWithTabs,
        clearNavParam: session.clearNavParam,
        initialArrayHash:
          state.view === 'arrays' ? state.params.arrayHash : undefined,
        hasFieldValues: overview.hasFieldValues,
      }),
    },
  ];

  for (const fg of session.flamegraphTabs) {
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
        onBackToTimeline: () => trace.navigate('#!/viewer'),
      }),
    });
  }

  for (const obj of session.instanceTabs) {
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

/**
 * Updates `session` so that calls to navigate() push the resulting
 * subpage into `window.location.hash`. Idempotent so it can be invoked
 * on every render — necessary because attrs can switch from one
 * session to another without a remount when the user loads a different
 * trace while the page is open.
 */
function bindHashRouter(session: HeapDumpExplorerSession): void {
  session.setNavigateCallback((sub) => {
    const href = `#!/heapdump${sub ? '/' + sub : ''}`;
    window.location.hash = href.slice(1);
  });
}

export class HeapDumpPage implements m.ClassComponent<HeapDumpPageAttrs> {
  // Track the session we last bound to, to detect cross-trace changes.
  private boundSession: HeapDumpExplorerSession | null = null;

  oncreate(vnode: m.VnodeDOM<HeapDumpPageAttrs>) {
    const {session, subpage} = vnode.attrs;
    if (!session) return;
    bindHashRouter(session);
    this.boundSession = session;
    session.syncFromSubpage(subpage);
    void session.loadOverview();
  }

  onremove() {
    this.boundSession?.setNavigateCallback(undefined);
    this.boundSession = null;
  }

  view(vnode: m.Vnode<HeapDumpPageAttrs>) {
    const {session, subpage} = vnode.attrs;

    if (!session) {
      // Drop stale binding from a previous trace.
      if (this.boundSession) {
        this.boundSession.setNavigateCallback(undefined);
        this.boundSession = null;
      }
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

    // Rebind the hash router whenever the session changes (e.g. new
    // trace loaded). The previous session's callback is dropped so it
    // can no longer push hash changes.
    if (this.boundSession !== session) {
      this.boundSession?.setNavigateCallback(undefined);
      bindHashRouter(session);
      this.boundSession = session;
      void session.loadOverview();
    }

    session.syncFromSubpage(subpage);
    session.syncInstanceTabFromNav();

    const overview = session.cachedOverview;
    if (!overview) {
      return m(
        'div',
        {class: 'ah-page'},
        m('div', {class: 'ah-loading'}, m(Spinner, {easing: true})),
      );
    }

    return m(
      'div',
      {class: 'ah-page'},
      m(
        'main',
        {class: 'ah-main'},
        m(Tabs, {
          tabs: buildTabs(session, session.nav, overview),
          activeTabKey: activeTabKey(session),
          onTabChange: (key: string) => handleTabChange(session, key),
          onTabClose: (key: string) => handleTabClose(session, key),
        }),
      ),
    );
  }
}
