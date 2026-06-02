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
import type {Setting} from '../../public/settings';
import type {Store} from '../../base/store';
import {NUM} from '../../trace_processor/query_result';

import {SQL_PREAMBLE} from './components';
import {flamegraphQuery} from './views/flamegraph_objects_view';
import * as queries from './queries';
import {
  type NavState,
  type NavView,
  stateToPath,
  stateToSubpage,
  subpageToState,
} from './nav_state';
import type {OverviewData} from './types';
import type {FlamegraphState} from '../../widgets/flamegraph';
import type {Column, Filter} from '../../components/widgets/datagrid/model';
import type {GridStateAccess} from './components';
import {
  type GridSlot,
  type GridStateJson,
  type HdeState,
  decodeGridSlot,
  encodeGridSlot,
} from './persisted_state';
import {
  METRIC_DOMINATED_OBJECT_SIZE,
  METRIC_OBJECT_SIZE,
} from './views/flamegraph_view';

interface FlamegraphSelection {
  readonly pathHashes: string;
  readonly isDominator: boolean;
  readonly upid: number;
  readonly ts: bigint;
}

interface FlamegraphTab extends FlamegraphSelection {
  readonly id: number;
  count: number | null;
}

interface InstanceTab {
  readonly id: number;
  readonly objId: number;
  readonly label: string;
}

const INSTANCE_LABEL_MAX = 30;

function truncateInstanceLabel(label: string): string {
  return label.length > INSTANCE_LABEL_MAX
    ? label.slice(0, INSTANCE_LABEL_MAX) + '…'
    : label;
}

// Created per onTraceLoad and replaced on the next one, so per-trace
// state disappears together. Dump switching within a trace keeps the
// session but drops per-dump caches.
export class HeapDumpExplorerSession {
  private _nav: NavState = {view: 'overview', params: {}};
  private _navigateCallback?: (subpage: string) => void;

  private _dumps: ReadonlyArray<queries.HeapDump> = [];
  private _activeDump: queries.HeapDump | null = null;

  private readonly _flamegraphTabs: FlamegraphTab[] = [];
  private _nextFlamegraphId = 0;
  private _activeFlamegraphId: number | null = null;

  private readonly _instanceTabs: InstanceTab[] = [];
  private _nextInstanceId = 0;
  private _activeInstanceId: number | null = null;

  private _overview: OverviewData | null = null;

  // Persists across tab switches; reset on dump change so a new dump
  // opens with defaults instead of the prior dump's filters.
  private _flamegraphPanelState: FlamegraphState | undefined;

  // Per-tab DataGrid state (column order/visibility/sort + filters), keyed by a
  // stable tab key. Only holds tabs the user actually customised; views fall
  // back to their own defaults for keys absent here. Reset on dump change.
  private readonly _grids = new Map<string, GridSlot>();

  // Set when the plugin auto-redirected to HDE on load; gates the
  // "default view changed" hint on the overview.
  autoNavigated = false;

  // Backs shared-link persistence: mirrored on every mutation, serialized into
  // the permalink by the core. Undefined where persistence isn't wired (tests).
  private readonly _store?: Store<HdeState>;

  constructor(
    readonly trace: Trace,
    readonly engine: Engine,
    readonly hideDefaultChangedHint: Setting<boolean>,
    store?: Store<HdeState>,
  ) {
    this._store = store;
  }

  get dumps(): ReadonlyArray<queries.HeapDump> {
    return this._dumps;
  }

  get activeDump(): queries.HeapDump | null {
    return this._activeDump;
  }

  async loadDumps(): Promise<void> {
    this._dumps = await queries.loadDumpsList(this.engine);
    this._activeDump = this._dumps.length > 0 ? this._dumps[0] : null;
  }

  selectDump(d: queries.HeapDump): void {
    if (this._activeDump === d) return;
    this.switchToDump(d);
    if (
      this._nav.view === 'object' ||
      this._nav.view === 'flamegraph-objects'
    ) {
      this.navigate('overview');
    }
    m.redraw();
  }

  private switchToDump(d: queries.HeapDump): void {
    this._activeDump = d;
    this.resetDumpScopedState();
    this.persist();
    void this.loadOverview();
  }

  get nav(): NavState {
    return this._nav;
  }

  setNavigateCallback(cb: ((subpage: string) => void) | undefined): void {
    this._navigateCallback = cb;
  }

  navigate(view: NavView, params: Record<string, unknown> = {}): void {
    this._nav = {view, params} as NavState;
    this._navigateCallback?.(stateToSubpage(this._nav));
    this.persist();
    m.redraw();
  }

  // Arrow property: passed by reference into Mithril attrs.
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
    this._activeInstanceId = null;
    this.navigate(view, params);
  };

  readonly clearNavParam = (key: string): void => {
    delete (this._nav.params as Record<string, unknown>)[key];
    // A consumed nav param (e.g. ?cls=Foo) becomes a one-shot grid filter, so
    // drop it from the persisted nav. Otherwise it would re-apply on restore
    // and clobber the user's later manual filter edits to the same grid.
    this.persist();
  };

  // --- Per-tab DataGrid state ------------------------------------------------

  gridColumns(key: string): readonly Column[] | undefined {
    return this._grids.get(key)?.columns;
  }

  gridFilters(key: string): readonly Filter[] {
    return this._grids.get(key)?.filters ?? [];
  }

  setGridColumns(key: string, columns: readonly Column[]): void {
    const prev = this._grids.get(key);
    this._grids.set(key, {columns, filters: prev?.filters ?? []});
    this.persist();
  }

  setGridFilters(key: string, filters: readonly Filter[]): void {
    const prev = this._grids.get(key);
    this._grids.set(key, {columns: prev?.columns, filters});
    this.persist();
  }

  // Bundles the accessors for one grid so a view can run DataGrid in controlled
  // mode without depending on the session directly.
  gridAccess(key: string): GridStateAccess {
    return {
      columns: this.gridColumns(key),
      filters: this.gridFilters(key),
      setColumns: (c) => this.setGridColumns(key, c),
      setFilters: (f) => this.setGridFilters(key, f),
    };
  }

  syncFromSubpage(subpage: string | undefined): void {
    const sub = subpage?.startsWith('/') ? subpage.slice(1) : subpage;
    // The router strips query params from `subpage`; compare path-only.
    const currentPath = this.navPath;
    const incomingPath = (sub ?? '').split('?')[0];
    if (incomingPath !== currentPath) {
      this._nav = subpageToState(sub);
      // Also capture URL-driven nav (back/forward, address bar) that bypasses
      // navigate(). Guarded on path change so it doesn't churn every redraw.
      this.persist();
    }
  }

  get flamegraphTabs(): ReadonlyArray<FlamegraphTab> {
    return this._flamegraphTabs;
  }

  get activeFlamegraphId(): number | null {
    return this._activeFlamegraphId;
  }

  setActiveFlamegraphTab(id: number): void {
    this._activeFlamegraphId = id;
    this.persist();
  }

  clearActiveFlamegraphTab(): void {
    this._activeFlamegraphId = null;
    this.persist();
  }

  openFlamegraph(sel: FlamegraphSelection): void {
    const target = this._dumps.find(
      (d) => d.upid === sel.upid && d.ts === sel.ts,
    );
    if (target && target !== this._activeDump) {
      this.switchToDump(target);
    }
    this.openFlamegraphTab(sel.pathHashes, sel.isDominator);
    this.navigate('flamegraph-objects', {
      pathHashes: sel.pathHashes,
      isDominator: sel.isDominator,
    });
  }

  // Creates or re-activates the flamegraph tab for a selection in the active
  // dump. Persists but does not navigate.
  private openFlamegraphTab(pathHashes: string, isDominator: boolean): void {
    const dump = this._activeDump;
    if (dump === null) {
      this._activeFlamegraphId = null;
      return;
    }
    const existing = this._flamegraphTabs.find(
      (t) => t.pathHashes === pathHashes && t.isDominator === isDominator,
    );
    if (existing) {
      this._activeFlamegraphId = existing.id;
      this.persist();
      return;
    }
    const tab: FlamegraphTab = {
      id: this._nextFlamegraphId++,
      count: null,
      pathHashes,
      isDominator,
      upid: dump.upid,
      ts: dump.ts,
    };
    this._flamegraphTabs.push(tab);
    this._activeFlamegraphId = tab.id;
    this.persist();
    this.refreshFlamegraphCount(tab);
  }

  // The drill-down tab title shows the object count, fetched async. Also called
  // on shared-link restore, where tabs are rebuilt without a count.
  private refreshFlamegraphCount(tab: FlamegraphTab): void {
    const q = flamegraphQuery(tab.pathHashes, tab.isDominator);
    this.engine
      .query(`${SQL_PREAMBLE}; SELECT COUNT(*) AS c FROM (${q})`)
      .then((r) => {
        tab.count = Number(r.firstRow({c: NUM}).c);
        m.redraw();
      })
      .catch(console.error);
  }

  closeFlamegraph(id: number): void {
    const idx = this._flamegraphTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this._flamegraphTabs.splice(idx, 1);
    if (this._activeFlamegraphId === id) {
      this._activeFlamegraphId = null;
      this.navigate('overview');
    } else {
      this.persist();
    }
  }

  get instanceTabs(): ReadonlyArray<InstanceTab> {
    return this._instanceTabs;
  }

  get activeInstanceId(): number | null {
    return this._activeInstanceId;
  }

  setActiveInstanceTab(id: number): void {
    this._activeInstanceId = id;
    this.persist();
  }

  clearActiveInstanceTab(): void {
    this._activeInstanceId = null;
    this.persist();
  }

  private openInstanceTab(objId: number, label?: string): void {
    const existing = this._instanceTabs.find((t) => t.objId === objId);
    if (existing) {
      this._activeInstanceId = existing.id;
      this.persist();
      return;
    }
    const tab: InstanceTab = {
      id: this._nextInstanceId++,
      objId,
      label: truncateInstanceLabel(label ?? 'Instance'),
    };
    this._instanceTabs.push(tab);
    this._activeInstanceId = tab.id;
    // Opened via URL nav (syncInstanceTabFromNav) bypasses navigate(), so
    // persist here.
    this.persist();
  }

  closeInstanceTab(id: number): void {
    const idx = this._instanceTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this._instanceTabs.splice(idx, 1);
    if (this._activeInstanceId === id) {
      this._activeInstanceId = null;
      this.navigate('overview');
    } else {
      this.persist();
    }
  }

  syncInstanceTabFromNav(): void {
    if (this._nav.view !== 'object') {
      this._activeInstanceId = null;
      return;
    }
    const {id, label} = this._nav.params;
    const existing = this._instanceTabs.find((t) => t.objId === id);
    if (existing) {
      this._activeInstanceId = existing.id;
    } else {
      this.openInstanceTab(id, label);
    }
  }

  syncFlamegraphTabFromNav(): void {
    if (this._nav.view !== 'flamegraph-objects') {
      this._activeFlamegraphId = null;
      return;
    }
    const {pathHashes, isDominator} = this._nav.params;
    if (pathHashes === undefined) {
      this._activeFlamegraphId = null;
      return;
    }
    const dom = isDominator ?? false;
    const existing = this._flamegraphTabs.find(
      (t) => t.pathHashes === pathHashes && t.isDominator === dom,
    );
    if (existing) {
      this._activeFlamegraphId = existing.id;
    } else {
      this.openFlamegraphTab(pathHashes, dom);
    }
  }

  private resetDumpScopedState(): void {
    this._overview = null;
    this._flamegraphTabs.length = 0;
    this._nextFlamegraphId = 0;
    this._activeFlamegraphId = null;
    this._instanceTabs.length = 0;
    this._nextInstanceId = 0;
    this._activeInstanceId = null;
    this._flamegraphPanelState = undefined;
    this._grids.clear();
  }

  // Mirrors the current session state into the store so it lands in shared
  // permalinks. Cheap no-op when no store is attached.
  private persist(): void {
    const store = this._store;
    if (store === undefined) return;
    const dump = this._activeDump;
    let grids: Record<string, GridStateJson> | undefined;
    if (this._grids.size > 0) {
      grids = {};
      for (const [key, slot] of this._grids) {
        grids[key] = encodeGridSlot(slot);
      }
    }
    const snapshot: HdeState = {
      activeDump:
        dump === null ? undefined : {upid: dump.upid, ts: dump.ts.toString()},
      nav: stateToSubpage(this._nav),
      flamegraphTabs: this._flamegraphTabs.map((t) => ({
        pathHashes: t.pathHashes,
        isDominator: t.isDominator,
        upid: t.upid,
        ts: t.ts.toString(),
      })),
      instanceTabs: this._instanceTabs.map((t) => ({
        objId: t.objId,
        label: t.label,
      })),
      flamegraphPanelState: this._flamegraphPanelState,
      grids,
    };
    store.edit((draft) => {
      Object.assign(draft, snapshot);
    });
  }

  // Rehydrates session state from a permalink; must run after loadDumps().
  // Returns false and changes nothing if there's no stored state or its dump is
  // gone from this trace.
  restoreFromStore(): boolean {
    const s = this._store?.state;
    const ref = s?.activeDump;
    if (s === undefined || ref === undefined) return false;
    const dump = this._dumps.find(
      (d) => d.upid === ref.upid && d.ts === BigInt(ref.ts),
    );
    if (dump === undefined) return false;

    this._activeDump = dump;

    this._flamegraphTabs.length = 0;
    this._nextFlamegraphId = 0;
    for (const t of s.flamegraphTabs ?? []) {
      this._flamegraphTabs.push({
        id: this._nextFlamegraphId++,
        count: null,
        pathHashes: t.pathHashes,
        isDominator: t.isDominator,
        upid: t.upid,
        ts: BigInt(t.ts),
      });
    }
    // The active flamegraph is not persisted: syncFlamegraphTabFromNav
    // re-derives it from the nav (which encodes the tab's pathHashes) on render.
    this._activeFlamegraphId = null;

    this._instanceTabs.length = 0;
    this._nextInstanceId = 0;
    for (const t of s.instanceTabs ?? []) {
      this._instanceTabs.push({
        id: this._nextInstanceId++,
        objId: t.objId,
        label: t.label,
      });
    }
    // The active instance is not persisted: syncInstanceTabFromNav re-derives it
    // from the nav (the 'object' view encodes the object id) on render.
    this._activeInstanceId = null;

    this._flamegraphPanelState = s.flamegraphPanelState;
    if (s.nav !== undefined) {
      this._nav = subpageToState(s.nav);
    }

    this._grids.clear();
    for (const [key, slot] of Object.entries(s.grids ?? {})) {
      this._grids.set(key, decodeGridSlot(slot));
    }

    for (const tab of this._flamegraphTabs) {
      this.refreshFlamegraphCount(tab);
    }
    return true;
  }

  // The current nav as a route path (no query params). Path-routing callers --
  // initialPage on a shared-link restore, the syncFromSubpage compare -- use
  // this; the params live in _nav, carried by the session rather than the URL.
  get navPath(): string {
    return stateToPath(this._nav);
  }

  get cachedOverview(): OverviewData | null {
    return this._overview;
  }

  get flamegraphPanelState(): FlamegraphState | undefined {
    return this._flamegraphPanelState;
  }

  readonly setFlamegraphPanelState = (s: FlamegraphState): void => {
    this._flamegraphPanelState = s;
    this.persist();
  };

  // Open the flamegraph pivoted at `pathHash`. The metric is chosen to
  // match the tree the hash came from. The chip displays
  // `<label> (this instance)` since the raw hash regex is unreadable.
  readonly openFlamegraphPivotedAt = (
    pathHash: string,
    label: string,
    isDominator: boolean,
  ): void => {
    this._flamegraphPanelState = {
      selectedMetricName: isDominator
        ? METRIC_DOMINATED_OBJECT_SIZE
        : METRIC_OBJECT_SIZE,
      filters: [],
      view: {
        kind: 'PIVOT',
        pivot: `^${pathHash}$`,
        displayLabel: `${label} (this instance)`,
      },
    };
    this.navigate('flamegraph');
  };

  // Pins the dump at fetch start; if the user switches dumps before
  // the result arrives, the result is dropped instead of briefly
  // displaying the wrong dump's overview.
  async loadOverview(): Promise<void> {
    if (this._overview !== null) return;
    const dump = this._activeDump;
    if (dump === null) return;
    try {
      const data = await queries.getOverview(this.engine, dump);
      if (this._activeDump === dump) this._overview = data;
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      m.redraw();
    }
  }
}
