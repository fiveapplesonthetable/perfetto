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
import {NUM} from '../../trace_processor/query_result';

import {SQL_PREAMBLE} from './components';
import {flamegraphQuery} from './views/flamegraph_objects_view';
import {getOverview} from './queries';
import {
  type NavState,
  type NavView,
  stateToSubpage,
  subpageToState,
} from './nav_state';
import type {OverviewData} from './types';

/** Identifies a closable flamegraph tab payload. */
export interface FlamegraphSelection {
  readonly pathHashes: string;
  readonly isDominator: boolean;
}

/** Closable flamegraph tab — one is created per "Open in Heapdump Explorer". */
export interface FlamegraphTab extends FlamegraphSelection {
  readonly id: number;
  count: number | null;
}

/** Closable instance tab — one is opened when an object link is clicked. */
export interface InstanceTab {
  readonly id: number;
  readonly objId: number;
  readonly label: string;
}

/**
 * Truncates a label so it fits a tab; matches the prior implementation.
 */
function truncateInstanceLabel(label: string): string {
  return label.length > 30 ? label.slice(0, 30) + '…' : label;
}

/**
 * Owns every piece of mutable state for one Heapdump Explorer trace
 * session: navigation, closable tab lists, the cached overview, the
 * subpage-update callback. Replaces a previous design that scattered
 * the same state across module-level `let` and `static` fields, which
 * made lifecycle and reset semantics implicit and easy to break.
 *
 * One session is created per `onTraceLoad`. When a different trace is
 * loaded, the old session is dropped and a new one takes its place;
 * because every per-trace cache (overview, tabs, navigation) lives on
 * the instance, nothing leaks across traces. The session is owned by
 * the plugin's {@link SessionRegistry}; consumers obtain it via the
 * page render callback (see index.ts) or via `attrs` on Mithril
 * components.
 */
export class HeapDumpExplorerSession {
  // ---------- Navigation state ----------
  private _nav: NavState = {view: 'overview', params: {}};
  private _navigateCallback?: (subpage: string) => void;

  // ---------- Closable flamegraph tabs ----------
  private readonly _flamegraphTabs: FlamegraphTab[] = [];
  private _nextFlamegraphId = 0;
  private _activeFlamegraphId = -1;

  // ---------- Closable instance tabs ----------
  private readonly _instanceTabs: InstanceTab[] = [];
  private _nextInstanceId = 0;
  private _activeInstanceId = -1;

  // ---------- Overview cache ----------
  // Survives component remounts (e.g. theme toggle). Cleared automatically
  // when the session is dropped.
  private _cachedOverview: OverviewData | null = null;
  private _overviewLoading = false;

  constructor(
    readonly trace: Trace,
    readonly engine: Engine,
  ) {}

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  get nav(): NavState {
    return this._nav;
  }

  /** Registered by the page on `oncreate`; cleared on `onremove`. */
  setNavigateCallback(cb: ((subpage: string) => void) | undefined): void {
    this._navigateCallback = cb;
  }

  /**
   * Switch to a different view. The optional `params` object's shape
   * depends on the destination view (see {@link NavState}).
   */
  navigate(view: NavView, params: Record<string, unknown> = {}): void {
    this._nav = {view, params} as NavState;
    this._navigateCallback?.(stateToSubpage(this._nav));
    m.redraw();
  }

  /**
   * Variant of {@link navigate} that intercepts navigation to the
   * `object` view and opens (or focuses) a closable instance tab.
   * Other navigations clear the active instance tab so fixed tabs are
   * shown.
   */
  readonly navigateWithTabs = (
    view: NavView,
    params?: Record<string, unknown>,
  ): void => {
    if (view === 'object') {
      this.openInstanceTab(
        params?.id as number,
        params?.label as string | undefined,
      );
      this.navigate(view, params);
      return;
    }
    this._activeInstanceId = -1;
    this.navigate(view, params);
  };

  /**
   * Clear a single nav param without pushing a history entry.
   * Used after consuming a one-shot param (e.g. a filter coming from
   * the overview panel into a list view).
   */
  readonly clearNavParam = (key: string): void => {
    const params = {...(this._nav.params as Record<string, unknown>)};
    delete params[key];
    this._nav = {view: this._nav.view, params} as NavState;
  };

  /** Re-derive nav state from the URL subpage when it differs. */
  syncFromSubpage(subpage: string | undefined): void {
    const sub = subpage?.startsWith('/') ? subpage.slice(1) : subpage;
    // Compare path-only: the router strips query params from `subpage`.
    const currentSubpage = stateToSubpage(this._nav);
    const currentPath = currentSubpage.split('?')[0];
    const incomingPath = (sub ?? '').split('?')[0];
    if (incomingPath !== currentPath) {
      this._nav = subpageToState(sub);
    }
  }

  // -----------------------------------------------------------------------
  // Flamegraph tabs
  // -----------------------------------------------------------------------

  get flamegraphTabs(): readonly FlamegraphTab[] {
    return this._flamegraphTabs;
  }

  get activeFlamegraphId(): number {
    return this._activeFlamegraphId;
  }

  setActiveFlamegraphId(id: number): void {
    this._activeFlamegraphId = id;
  }

  /**
   * Open a flamegraph tab for `sel`, or focus the existing one if a
   * tab with the same selection is already open. Asynchronously fills
   * in the tab's row count for display in the title.
   */
  openFlamegraph(sel: FlamegraphSelection): void {
    const existing = this._flamegraphTabs.find(
      (t) =>
        t.pathHashes === sel.pathHashes && t.isDominator === sel.isDominator,
    );
    if (existing) {
      this._activeFlamegraphId = existing.id;
      this.navigate('flamegraph-objects');
      return;
    }
    const tab: FlamegraphTab = {
      id: this._nextFlamegraphId++,
      count: null,
      pathHashes: sel.pathHashes,
      isDominator: sel.isDominator,
    };
    this._flamegraphTabs.push(tab);
    this._activeFlamegraphId = tab.id;

    const q = flamegraphQuery(sel.pathHashes, sel.isDominator);
    this.engine
      .query(`${SQL_PREAMBLE}; SELECT COUNT(*) AS c FROM (${q})`)
      .then((r) => {
        tab.count = Number(r.firstRow({c: NUM}).c);
        m.redraw();
      });
    this.navigate('flamegraph-objects');
  }

  /**
   * Close a flamegraph tab. If the active tab was the closed one, falls
   * back to the overview tab.
   */
  closeFlamegraph(id: number): void {
    const idx = this._flamegraphTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this._flamegraphTabs.splice(idx, 1);
    if (this._activeFlamegraphId === id) {
      this._activeFlamegraphId = -1;
      this.navigate('overview');
    }
  }

  // -----------------------------------------------------------------------
  // Instance tabs
  // -----------------------------------------------------------------------

  get instanceTabs(): readonly InstanceTab[] {
    return this._instanceTabs;
  }

  get activeInstanceId(): number {
    return this._activeInstanceId;
  }

  setActiveInstanceId(id: number): void {
    this._activeInstanceId = id;
  }

  /**
   * Open (or focus) an object instance tab. The label, if provided, is
   * truncated to fit a tab title.
   */
  openInstanceTab(objId: number, label?: string): void {
    const existing = this._instanceTabs.find((t) => t.objId === objId);
    if (existing) {
      this._activeInstanceId = existing.id;
      return;
    }
    const tab: InstanceTab = {
      id: this._nextInstanceId++,
      objId,
      label: truncateInstanceLabel(label ?? 'Instance'),
    };
    this._instanceTabs.push(tab);
    this._activeInstanceId = tab.id;
  }

  /**
   * Close an instance tab. If the active tab was the closed one, falls
   * back to the overview tab.
   */
  closeInstanceTab(id: number): void {
    const idx = this._instanceTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this._instanceTabs.splice(idx, 1);
    if (this._activeInstanceId === id) {
      this._activeInstanceId = -1;
      this.navigate('overview');
    }
  }

  /**
   * After a back/forward pushed nav.view to 'object', make sure the
   * matching instance tab exists and is active. When nav points at any
   * other view, clear the active instance id so fixed tabs are shown.
   */
  syncInstanceTabFromNav(): void {
    if (this._nav.view !== 'object') {
      this._activeInstanceId = -1;
      return;
    }
    const objId = (this._nav.params as {id: number}).id;
    const label = (this._nav.params as {label?: string}).label;
    const existing = this._instanceTabs.find((t) => t.objId === objId);
    if (existing) {
      this._activeInstanceId = existing.id;
    } else {
      this.openInstanceTab(objId, label);
    }
  }

  // -----------------------------------------------------------------------
  // Overview cache
  // -----------------------------------------------------------------------

  get cachedOverview(): OverviewData | null {
    return this._cachedOverview;
  }

  /**
   * Load the overview data lazily, deduplicating concurrent requests.
   * Resolves immediately when already cached.
   */
  async loadOverview(): Promise<void> {
    if (this._overviewLoading || this._cachedOverview) return;
    this._overviewLoading = true;
    try {
      this._cachedOverview = await getOverview(this.engine);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load overview:', err);
    } finally {
      this._overviewLoading = false;
      m.redraw();
    }
  }
}
