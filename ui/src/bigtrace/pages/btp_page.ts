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

// Backend status page. Endpoint-agnostic: hits a configurable
// `bigtraceEndpoint` over plain HTTP/JSON, no compiled-in coupling
// to any specific daemon. The reference implementation is
// `python/tools/btp_serve.py`, but anything that speaks the contract
// below works.
//
// Contract (every endpoint returns JSON unless noted):
//
//   GET  /info             Realtime pool + machine snapshot. Shape:
//     {
//       trace_count, max_loaded, pool_mode, session_dir,
//       cpu_workers, memory_budget_mb, query_timeout_s,
//       machine_cores_total, machine_memory_mb_total,
//       loaded, loading, evicted, running,
//       running_handles: [{handle_idx, _path, state,
//                          pin_count, load_count}, ...],
//       memory_used_mb,
//       total_reloads, load_failures,
//       failure_counts: {kind: n, ...}
//     }
//   GET  /traces           [{handle_idx, state, pin_count,
//                            load_count, _path?, ...metadata}, ...]
//   POST /traces           {path, metadata?} -> {handle_idx}
//   GET  /queries          [{query_id, sql, started, completed,
//                            total_traces, cached_traces,
//                            is_complete}, ...]
//   POST /run              {sql} -> {query_id} (synchronous;
//                                    rows live at /results/<qid>)
//   GET  /results/<qid>    [row, ...] (JSON rows; ?format=arrow
//                                      streams Arrow IPC)
//   GET  /progress         {query_id, sql, total, completed, failed,
//                           started_ts, eta_s} or empty when idle
//   GET  /failures         [{handle_idx, kind, detail, when,
//                            exit_code?, stderr_tail?, ...}, ...]
//   GET  /config           Whole config dict.
//   POST /config           Partial config patch -> {config, info}.
//                          Honours cpu_workers, memory_budget_mb,
//                          query_timeout_s live.
//   POST /cancel           Cancel any in-flight query.
//   POST /shutdown         Clean stop of the backend.
//
// This page renders /info + /traces + /queries + /failures +
// /progress on a 1.5s poll. The /query page (existing bigtrace UI)
// runs SQL via /run + /results/<qid> against the same endpoint.

import m from 'mithril';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Button, ButtonVariant} from '../../widgets/button';
import {EmptyState} from '../../widgets/empty_state';
import {FormGrid, FormLabel} from '../../widgets/form';
import {SettingsShell, SettingsCard} from '../../widgets/settings_shell';
import {Stack, StackAuto} from '../../widgets/stack';
import {TextInput} from '../../widgets/text_input';
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import {SchemaRegistry} from '../../components/widgets/datagrid/datagrid_schema';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import {Row as DataGridRow} from '../../trace_processor/query_result';
import {endpointStorage} from '../settings/endpoint_storage';
import {setRoute} from '../router';
import {Routes} from '../routes';

// ---------------------------------------------------------------------------
// Wire-format types — match `python/perfetto/batch_trace_processor/server.py`.

interface BtpInfo {
  trace_count: number;
  pool_mode: 'unbounded' | 'lru';
  workers: number;
  // User-facing budget pair (the editable knobs).
  cpu_workers: number;
  memory_budget_mb: number | null;
  query_timeout_s: number;
  // Machine totals — for the "half of N" hint next to each input.
  machine_cores_total: number;
  machine_memory_mb_total: number | null;
  session_dir: string | null;
  max_loaded: number;
  // Realtime pool-state counts.
  loaded: number;
  loading: number;
  evicted: number;
  running: number;
  // Per-trace info for handles currently mid-query (pin_count > 0).
  // Bounded by query parallelism so this stays small even on huge
  // corpora.
  running_handles: Array<{
    handle_idx: number;
    _path: string;
    state: string;
    pin_count: number;
    load_count: number;
  }>;
  // Sum of /proc/<tp pid>/status:VmRSS across alive shells, in MB.
  memory_used_mb: number;
  // Cumulative counters.
  total_reloads: number;
  load_failures: number;
  failure_counts: Record<string, number>;
}

interface BtpTrace {
  handle_idx: number;
  _path?: string;
  // Live state injected by the BTP server.
  state?: 'evicted' | 'loading' | 'loaded';
  pin_count?: number;
  load_count?: number;
  [key: string]: unknown;
}

interface BtpQuery {
  query_id: string;
  sql: string;
  started: number;
  completed: number | null;
  total_traces: number;
  cached_traces: number;
  is_complete: boolean;
}

interface BtpProgress {
  query_id: string;
  sql: string;
  total: number;
  completed: number;
  failed: number;
  started_ts: number;
  eta_s: number;
}

type FailureKind =
  | 'load_timeout'
  | 'load_failed'
  | 'missing_file'
  | 'tp_crash'
  | 'query_timeout'
  | 'query_error'
  | 'unknown';

interface BtpFailure {
  handle_idx: number;
  kind: FailureKind;
  detail: string;
  when: number;
  exit_code: number | null;
  stderr_tail: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Cell formatting

function fmtTimestamp(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '';
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const ago = Math.max(0, (Date.now() - d.getTime()) / 1000);
  const rel =
    ago < 1
      ? 'just now'
      : ago < 60
        ? `${Math.round(ago)}s ago`
        : ago < 3600
          ? `${Math.round(ago / 60)}m ago`
          : `${Math.round(ago / 3600)}h ago`;
  return `${d.toLocaleTimeString()} (${rel})`;
}

// ---------------------------------------------------------------------------
// HTTP client + status store

class BtpClient {
  constructor(public host: string) {}
  private url(path: string): string {
    return `${this.host.replace(/\/+$/, '')}${path}`;
  }
  async getJson<T>(path: string): Promise<T> {
    const r = await fetch(this.url(path), {method: 'GET'});
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }
  async postJson<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.url(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Bubble up the server's error message when present so the
      // user sees "memory_budget_mb must be >= 64" rather than just
      // "HTTP 400".
      let detail = '';
      try {
        const j = (await r.json()) as unknown;
        if (j !== null && typeof j === 'object' && 'error' in j) {
          detail = `: ${(j as {error: string}).error}`;
        }
      } catch (_e) {
        // ignore
      }
      throw new Error(`${path}: HTTP ${r.status}${detail}`);
    }
    return r.json() as Promise<T>;
  }
}

// Draft state for the editable Configuration card. Values are strings
// because that's what the <input> emits; we coerce on save. `null`
// for a slot means "no edit pending — show the live value".
interface ConfigDraft {
  cpu_workers: string | null;
  memory_budget_mb: string | null;
  query_timeout_s: string | null;
}

interface StoreState {
  endpoint: string;
  client: BtpClient | null;
  info: BtpInfo | null;
  traces: BtpTrace[];
  queries: BtpQuery[];
  failures: BtpFailure[];
  progress: BtpProgress | null;
  error: string;
  lastRefresh: number;
  refreshTimer: number | null;
  tracesDataSource: InMemoryDataSource | null;
  tracesEpoch: number;
  configDraft: ConfigDraft;
  configSaving: boolean;
  configError: string;
  configLastSaveTs: number;
}

const store: StoreState = {
  endpoint: '',
  client: null,
  info: null,
  traces: [],
  queries: [],
  failures: [],
  progress: null,
  error: '',
  lastRefresh: 0,
  refreshTimer: null,
  tracesDataSource: null,
  tracesEpoch: 0,
  configDraft: {
    cpu_workers: null,
    memory_budget_mb: null,
    query_timeout_s: null,
  },
  configSaving: false,
  configError: '',
  configLastSaveTs: 0,
};

function configHasPendingEdits(): boolean {
  const d = store.configDraft;
  return (
    d.cpu_workers !== null ||
    d.memory_budget_mb !== null ||
    d.query_timeout_s !== null
  );
}

async function saveConfig(): Promise<void> {
  const c = store.client;
  if (c === null) return;
  const d = store.configDraft;
  const body: Record<string, number> = {};
  // Coerce only the slots the user actually touched; leave others
  // alone so we don't accidentally write a stale value.
  if (d.cpu_workers !== null) {
    const n = Number(d.cpu_workers);
    if (!Number.isFinite(n) || n < 1) {
      store.configError = 'cpu_workers must be >= 1';
      m.redraw();
      return;
    }
    body.cpu_workers = Math.floor(n);
  }
  if (d.memory_budget_mb !== null) {
    const n = Number(d.memory_budget_mb);
    if (!Number.isFinite(n) || n < 64) {
      store.configError = 'memory_budget_mb must be >= 64';
      m.redraw();
      return;
    }
    body.memory_budget_mb = Math.floor(n);
  }
  if (d.query_timeout_s !== null) {
    const n = Number(d.query_timeout_s);
    if (!Number.isFinite(n) || n < 1) {
      store.configError = 'query_timeout_s must be >= 1';
      m.redraw();
      return;
    }
    body.query_timeout_s = Math.floor(n);
  }
  if (Object.keys(body).length === 0) return;
  store.configSaving = true;
  store.configError = '';
  m.redraw();
  try {
    await c.postJson<unknown>('/config', body);
    // Server echoes new state; refresh /info so the page snaps to
    // the just-saved values without waiting for the next poll tick.
    store.configDraft = {
      cpu_workers: null,
      memory_budget_mb: null,
      query_timeout_s: null,
    };
    store.configLastSaveTs = Date.now();
    await refreshAll();
  } catch (e) {
    store.configError = (e as Error).message;
  } finally {
    store.configSaving = false;
    m.redraw();
  }
}

function discardConfigEdits(): void {
  store.configDraft = {
    cpu_workers: null,
    memory_budget_mb: null,
    query_timeout_s: null,
  };
  store.configError = '';
  m.redraw();
}

async function refreshAll(): Promise<void> {
  const c = store.client;
  if (c === null) return;
  try {
    const [info, traces, queries, failures, progress] = await Promise.all([
      c.getJson<BtpInfo>('/info'),
      c.getJson<BtpTrace[]>('/traces'),
      c.getJson<BtpQuery[]>('/queries'),
      c.getJson<BtpFailure[]>('/failures'),
      c.getJson<BtpProgress>('/progress'),
    ]);
    store.info = info;
    // Rebuild the DataGrid source only when the actual trace list
    // grew/shrank or the first row's path changed — otherwise we'd
    // throw away the user's sort/filter on every poll.
    const epochInputs = traces.length === 0 ? '' : traces[0]._path ?? '';
    if (
      store.tracesDataSource === null ||
      store.traces.length !== traces.length ||
      epochInputs !==
        (store.traces.length === 0 ? '' : store.traces[0]?._path ?? '')
    ) {
      store.tracesDataSource = new InMemoryDataSource(
        traces as ReadonlyArray<DataGridRow>,
      );
      store.tracesEpoch += 1;
    }
    store.traces = traces;
    store.queries = queries;
    store.failures = failures;
    store.progress = progress;
    store.error = '';
  } catch (e) {
    store.error = (e as Error).message;
  }
  store.lastRefresh = Date.now();
  m.redraw();
}

function reconfigureFromSettings(): void {
  const setting = endpointStorage.get('bigtraceEndpoint');
  const url = setting ? (setting.get() as string) || '' : '';
  if (url === store.endpoint) return;
  store.endpoint = url;
  store.client = url.length > 0 ? new BtpClient(url) : null;
  store.info = null;
  store.traces = [];
  store.queries = [];
  store.failures = [];
  store.progress = null;
  store.error = '';
  store.tracesDataSource = null;
  if (store.client !== null) void refreshAll();
}

function startPolling(): void {
  stopPolling();
  store.refreshTimer = window.setInterval(refreshAll, 1500);
}

function stopPolling(): void {
  if (store.refreshTimer !== null) {
    window.clearInterval(store.refreshTimer);
    store.refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Render helpers

function renderHeaderControls(): m.Children {
  return m(
    Stack,
    {orientation: 'horizontal', spacing: 'small'},
    m(StackAuto),
    store.lastRefresh > 0 &&
      m(
        '.pf-btp__last-refresh',
        `refreshed ${fmtTimestamp(store.lastRefresh / 1000)}`,
      ),
    m(Button, {
      label: 'Settings',
      icon: 'settings',
      variant: ButtonVariant.Outlined,
      onclick: () => setRoute(Routes.SETTINGS),
    }),
    m(Button, {
      label: 'Refresh',
      icon: 'refresh',
      variant: ButtonVariant.Filled,
      intent: Intent.Primary,
      onclick: () => void refreshAll(),
    }),
  );
}

function fmtMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '—';
  if (mb >= 1024 * 1024) {
    return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  }
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toLocaleString()} MB`;
}

function pct(used: number, budget: number | null | undefined): number {
  if (budget === null || budget === undefined || budget <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * used) / budget)));
}

function renderStatusBanner(): m.Children {
  const i = store.info;
  if (i === null) return null;
  const ok = store.error.length === 0;
  return m(
    Callout,
    {
      icon: ok ? 'cloud_done' : 'cloud_off',
      intent: ok ? Intent.Success : Intent.Danger,
    },
    m(
      Stack,
      {orientation: 'horizontal', spacing: 'small'},
      m(
        '',
        ok ? 'Connected to ' : 'Cannot reach ',
        m('strong', store.endpoint),
        ' · ',
        m('strong', i.trace_count.toLocaleString()),
        ' traces',
      ),
      m(StackAuto),
      store.lastRefresh > 0 &&
        m(
          'span.pf-btp__muted-stat',
          `updated ${fmtTimestamp(store.lastRefresh / 1000)}`,
        ),
    ),
  );
}

// One horizontal row in the Resource usage card. Uses the same look as
// the cgroup memory bars in the Recording UI so the analyst's eye is
// already trained for it.
// One labelled progress row: "Memory  117 MB / 60 GB  (1%)".
// Single format function for the value cell to avoid the earlier
// "0 / 64 / 64" double-format bug.
function resourceRow(
  label: string,
  usedText: string,
  totalText: string,
  pctValue: number,
): m.Children {
  const dangerous = pctValue >= 90;
  return m(
    '.pf-btp__resource-row',
    m('.pf-btp__resource-label', label),
    m(
      '.pf-btp__resource-bar',
      m('.pf-btp__resource-fill', {
        style: `width: ${pctValue}%; background: var(${
          dangerous ? '--pf-color-danger' : '--pf-color-primary'
        });`,
      }),
    ),
    m(
      '.pf-btp__resource-value',
      `${usedText} / ${totalText}`,
      m('span.pf-btp__kv-hint', `  ${pctValue}%`),
    ),
  );
}

function renderResourceUsageCard(): m.Children {
  const i = store.info;
  if (i === null) return null;
  const workersBudget = Math.max(1, i.cpu_workers);
  const memBudget = i.memory_budget_mb;

  return m(SettingsCard, {
    title: 'Resource usage',
    description:
      'How much of each budget the BTP is currently using. Bars turn ' +
      'red at 90%; once memory budget is exhausted, the LRU trace is ' +
      'killed and re-parsed when next queried.',
    controls: m(
      Stack,
      {orientation: 'vertical', spacing: 'small'},
      resourceRow(
        'Memory',
        fmtMb(i.memory_used_mb),
        fmtMb(memBudget),
        pct(i.memory_used_mb, memBudget),
      ),
      resourceRow(
        'Workers',
        `${i.running}`,
        `${workersBudget}`,
        pct(i.running, workersBudget),
      ),
    ),
  });
}

// Plain-language pool summary.
//   "in memory"  = a parsed trace processor running, ready to answer
//                  queries with no extra latency.
//   "needs reload" = trace processor closed; the trace must be
//                  re-parsed from its `.perfetto-trace` file on next
//                  use. Expensive (seconds, depending on trace size).
function renderRealtimeCard(): m.Children {
  const i = store.info;
  if (i === null) return null;
  const sentence =
    `${i.loaded.toLocaleString()} in memory, ` +
    `${i.evicted.toLocaleString()} need reload`;
  return m(SettingsCard, {
    title: 'Pool',
    description:
      'Where each trace currently lives. ' +
      '"In memory" = parsed shell ready to query instantly. ' +
      '"Needs reload" = killed; re-parses from disk on next query.',
    controls: m(
      Stack,
      {orientation: 'vertical', spacing: 'small'},
      m('p.pf-btp__pool-summary', sentence),
      i.running_handles.length > 0 &&
        m(
          'p.pf-btp__pool-running',
          'Querying now: ',
          ...i.running_handles.slice(0, 8).map((h, idx) => {
            const base =
              h._path === ''
                ? `#${h.handle_idx}`
                : h._path.split('/').pop() ?? `#${h.handle_idx}`;
            return [idx > 0 && ', ', m('code', base)];
          }),
          i.running_handles.length > 8 &&
            ` (+${i.running_handles.length - 8} more)`,
        ),
      m(
        '.pf-btp__muted-stat',
        `Lifetime: `,
        `${i.total_reloads.toLocaleString()} reloads`,
        i.load_failures > 0 &&
          `, ${i.load_failures.toLocaleString()} failed loads`,
      ),
    ),
  });
}

function renderConfigCard(): m.Children {
  const i = store.info;
  if (i === null) return null;

  // FormLabel + TextInput pair, aligned via FormGrid (Perfetto's
  // standard form pattern — see ui/src/widgets/form.ts).
  const formRow = (
    label: string,
    draftKey: keyof ConfigDraft,
    liveValue: number | null,
    minValue: number,
  ): m.Children[] => {
    const draft = store.configDraft[draftKey];
    const displayValue = draft !== null ? draft : liveValue ?? '';
    return [
      m(FormLabel, {for: `pf-btp-cfg-${draftKey}`}, label),
      m(TextInput, {
        'id': `pf-btp-cfg-${draftKey}`,
        'type': 'number',
        'min': minValue,
        'step': 1,
        'data-testid': `pf-btp-cfg-${draftKey}`,
        'value': String(displayValue),
        'disabled': store.configSaving,
        'onInput': (v: string) => {
          store.configDraft = {...store.configDraft, [draftKey]: v};
        },
      }),
    ];
  };

  return m(SettingsCard, {
    title: 'Configuration',
    description:
      'Resource budgets the BTP enforces. Saved values apply ' +
      'immediately — the cgroup is updated, the worker pool is ' +
      'resized, and the result cache is pruned. Defaults to half ' +
      "of the machine's resources.",
    controls: m(
      Stack,
      {orientation: 'vertical', spacing: 'medium'},
      m(
        FormGrid,
        ...formRow('CPU workers', 'cpu_workers', i.cpu_workers, 1),
        ...formRow(
          'Memory budget (MB)',
          'memory_budget_mb',
          i.memory_budget_mb,
          64,
        ),
        ...formRow(
          'Query timeout (seconds)',
          'query_timeout_s',
          Math.round(i.query_timeout_s),
          1,
        ),
      ),
      store.configError !== '' &&
        m(Callout, {icon: 'error', intent: Intent.Danger}, store.configError),
      m(
        Stack,
        {orientation: 'horizontal', spacing: 'small'},
        m(StackAuto),
        store.configLastSaveTs > 0 &&
          !configHasPendingEdits() &&
          m(
            'span.pf-btp__muted-stat',
            `saved ${fmtTimestamp(store.configLastSaveTs / 1000)}`,
          ),
        m(Button, {
          label: 'Discard',
          variant: ButtonVariant.Outlined,
          disabled: !configHasPendingEdits() || store.configSaving,
          onclick: discardConfigEdits,
        }),
        m(Button, {
          'label': store.configSaving ? 'Saving…' : 'Save',
          'data-testid': 'pf-btp-cfg-save',
          'variant': ButtonVariant.Filled,
          'intent': Intent.Primary,
          'disabled': !configHasPendingEdits() || store.configSaving,
          'onclick': () => void saveConfig(),
        }),
      ),
    ),
  });
}

function renderProgressCard(): m.Children {
  const p = store.progress;
  if (p === null || p.total === 0 || p.query_id === '') return null;
  const fraction = Math.round((100 * p.completed) / Math.max(1, p.total));
  return m(SettingsCard, {
    title: 'Running query',
    accent: Intent.Primary,
    controls: m(
      Stack,
      {orientation: 'vertical', spacing: 'small'},
      // Single sentence summary, no abbreviations.
      m(
        'p.pf-btp__pool-summary',
        `Processed ${p.completed.toLocaleString()} of `,
        `${p.total.toLocaleString()} traces (${fraction}%)`,
        p.eta_s > 0 && `, about ${p.eta_s.toFixed(0)}s left`,
        p.failed > 0 && `, ${p.failed.toLocaleString()} failed`,
        '.',
      ),
      // Real determinate progress bar — width matches the fraction.
      m(
        '.pf-btp__resource-bar',
        m('.pf-btp__resource-fill', {
          style: `width: ${fraction}%; background: var(--pf-color-primary);`,
        }),
      ),
      // SQL in a code block, full width, monospace.
      m(
        'pre.pf-btp__sql-block',
        p.sql.length > 400 ? p.sql.slice(0, 400) + '…' : p.sql,
      ),
    ),
  });
}

function renderTracesCard(): m.Children {
  if (store.traces.length === 0) {
    return m(SettingsCard, {
      title: 'Traces',
      controls: m('em', 'no traces'),
    });
  }
  const cols = Object.keys(store.traces[0]);
  const ds = store.tracesDataSource;
  if (ds === null) return null;
  const schema: SchemaRegistry = {data: {}};
  return m(SettingsCard, {
    title: `Traces (${store.traces.length.toLocaleString()})`,
    description:
      '`_path` + every metadata column you supplied via ' +
      '`TracesWithMetadata`. Filter / sort / export — same DataGrid ' +
      'used by the /query page.',
    controls: m(DataGrid, {
      schema,
      rootSchema: 'data',
      enablePivotControls: false,
      data: ds,
      initialColumns: cols.map((c) => ({id: c, field: c})),
      className: 'pf-btp__traces-grid',
      showExportButton: true,
      emptyStateMessage: 'no traces',
    }),
  });
}

function renderQueriesCard(): m.Children {
  if (store.queries.length === 0) {
    // Compact italic placeholder — don't take up a whole card just to
    // say "nothing here yet."
    return m(
      'p.pf-btp__placeholder',
      m('em', 'No queries yet. Run SQL on '),
      m('em', m('code', '/query')),
      m('em', ' to see history here.'),
    );
  }
  return m(SettingsCard, {
    title: `Queries (${store.queries.length.toLocaleString()})`,
    controls: m(
      '.pf-btp__table-scroll',
      m(
        'table.pf-btp__table',
        m(
          'thead',
          m(
            'tr',
            m('th', 'SQL'),
            m('th.pf-btp__num', 'Started'),
            m('th.pf-btp__num', 'Traces'),
            m('th', 'Status'),
          ),
        ),
        m(
          'tbody',
          store.queries.map((q) =>
            m(
              'tr',
              m(
                'td',
                {title: q.sql},
                q.sql.length > 80 ? q.sql.slice(0, 80) + '…' : q.sql,
              ),
              m(
                'td.pf-btp__num',
                {title: new Date(q.started * 1000).toLocaleString()},
                fmtRelative(q.started),
              ),
              m(
                'td.pf-btp__num',
                `${q.cached_traces.toLocaleString()}/${q.total_traces.toLocaleString()}`,
              ),
              m('td', q.is_complete ? 'complete' : 'running'),
            ),
          ),
        ),
      ),
    ),
  });
}

function fmtRelative(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const ago = Math.max(0, Date.now() / 1000 - secs);
  if (ago < 60) return `${Math.round(ago)}s ago`;
  if (ago < 3600) return `${Math.round(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.round(ago / 3600)}h ago`;
  return `${Math.round(ago / 86400)}d ago`;
}

function renderFailuresCard(): m.Children {
  if (store.failures.length === 0) return null;
  const i = store.info;
  const counts = i?.failure_counts ?? ({} as Record<string, number>);
  return m(SettingsCard, {
    title: `Failures (${store.failures.length.toLocaleString()})`,
    accent: Intent.Danger,
    description: m(
      'span',
      Object.entries(counts).map(([kind, n]) =>
        m('span.pf-btp__pill.pf-btp__pill--muted', `${kind}: ${n}`),
      ),
    ),
    controls: m(
      '.pf-btp__table-scroll',
      m(
        'table.pf-btp__table',
        m(
          'thead',
          m(
            'tr',
            m('th.pf-btp__num', 'handle'),
            m('th', 'kind'),
            m('th', 'when'),
            m('th.pf-btp__num', 'exit'),
            m('th', 'detail'),
          ),
        ),
        m(
          'tbody',
          store.failures.map((f) =>
            m(
              'tr',
              {title: f.stderr_tail ?? ''},
              m('td.pf-btp__num', f.handle_idx),
              m('td', m(`span.pf-btp__kind--${f.kind}`, f.kind)),
              m('td', fmtTimestamp(f.when)),
              m('td.pf-btp__num', f.exit_code === null ? '' : f.exit_code),
              m(
                'td',
                f.detail.length > 100 ? f.detail.slice(0, 100) + '…' : f.detail,
              ),
            ),
          ),
        ),
      ),
    ),
  });
}

function renderEmptyState(): m.Children {
  return m(
    EmptyState,
    {
      title: 'No BTP endpoint configured',
      icon: 'settings_ethernet',
      fillHeight: true,
    },
    m(
      Stack,
      {orientation: 'vertical', spacing: 'medium'},
      m(
        '',
        'Set "Bigtrace endpoint" in Settings to a running ',
        m('code', 'btp.serve(...)'),
        ' instance (e.g. ',
        m('code', 'python3 python/tools/btp_serve.py /path/to/traces'),
        ').',
      ),
      m(Button, {
        label: 'Open Settings',
        icon: 'settings',
        variant: ButtonVariant.Filled,
        intent: Intent.Primary,
        onclick: () => setRoute(Routes.SETTINGS),
      }),
    ),
  );
}

function renderUnreachable(): m.Children {
  return m(
    Callout,
    {
      intent: Intent.Danger,
      icon: 'error',
      title: 'BTP endpoint unreachable',
    },
    m(
      Stack,
      {orientation: 'vertical', spacing: 'small'},
      m('', store.error),
      m(
        '',
        'Endpoint: ',
        m('code', store.endpoint),
        '. Check that ',
        m('code', 'btp.serve(...)'),
        ' is running and the URL is correct in Settings.',
      ),
      m(
        Stack,
        {orientation: 'horizontal', spacing: 'small'},
        m(Button, {
          label: 'Open Settings',
          icon: 'settings',
          variant: ButtonVariant.Outlined,
          onclick: () => setRoute(Routes.SETTINGS),
        }),
        m(Button, {
          label: 'Retry',
          icon: 'refresh',
          variant: ButtonVariant.Filled,
          intent: Intent.Primary,
          onclick: () => void refreshAll(),
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Page entry point — wraps everything in SettingsShell so the layout
// matches /settings exactly: sticky title, centred 880px column, same
// card spacing.

export class BtpPage implements m.ClassComponent {
  oninit() {
    reconfigureFromSettings();
    startPolling();
  }
  onbeforeupdate() {
    reconfigureFromSettings();
    return true;
  }
  onremove() {
    stopPolling();
  }

  view(): m.Children {
    return m(
      SettingsShell,
      {
        title: 'Batch Trace Processor',
        className: 'pf-btp__page',
        stickyHeaderContent: renderHeaderControls(),
      },
      store.client === null
        ? renderEmptyState()
        : store.error.length > 0 && store.info === null
          ? renderUnreachable()
          : m(
              '.pf-btp__sections',
              renderStatusBanner(),
              renderProgressCard(),
              renderResourceUsageCard(),
              renderRealtimeCard(),
              renderConfigCard(),
              renderQueriesCard(),
              renderTracesCard(),
              renderFailuresCard(),
            ),
    );
  }
}
