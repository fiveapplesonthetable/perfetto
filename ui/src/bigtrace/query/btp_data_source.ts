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

// Data source for the bigtrace /query page that talks to a Python
// `BatchTraceProcessor` HTTP server (`btp.serve(...)`). Mirrors the
// shape of `HttpDataSource` so the query page can swap between the
// brush gRPC backend and BTP without restructuring the page itself.
//
// Wire format documented in
// `python/perfetto/batch_trace_processor/server.py`:
//   POST /run         { sql: str } -> { query_id: str }
//   GET  /results/qid -> [{...row}, ...]   // pandas DataFrame rows
//                                          // with `_handle_idx` injected
// Per-trace metadata configured via `TracesWithMetadata` is flattened
// into result rows by the BTP's `query_and_flatten`, so the resulting
// columns include user-supplied metadata (device, scenario, build, ...)
// alongside the SELECT projection — same shape the brush backend uses.

import {Row as DataGridRow} from '../../trace_processor/query_result';

export class BtpDataSource {
  private endpoint: string;
  private baseQuery: string;
  private cachedRows: DataGridRow[] | null = null;
  private fetchPromise: Promise<DataGridRow[]> | null = null;
  private abortController: AbortController | null = null;

  constructor(endpoint: string, baseQuery: string) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.baseQuery = baseQuery;
  }

  abort(): void {
    if (this.abortController !== null) {
      this.abortController.abort();
    }
  }

  async query(forceRefresh = false): Promise<DataGridRow[]> {
    if (this.cachedRows !== null && !forceRefresh) {
      return this.cachedRows;
    }
    if (this.fetchPromise !== null && !forceRefresh) {
      return this.fetchPromise;
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.fetchPromise = (async () => {
      // 1) POST /run — synchronous on the server: returns once every
      // per-trace result is in the durable cache. The server's
      // `_assert_healthy` rejects if the executor was shut down.
      const runResp = await fetch(`${this.endpoint}/run`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sql: this.baseQuery}),
        signal,
      });
      if (!runResp.ok) {
        const text = await runResp.text().catch(() => '');
        throw new Error(`POST /run failed: HTTP ${runResp.status} ${text}`);
      }
      const runJson = (await runResp.json()) as {
        query_id?: string;
        error?: string;
      };
      if (signal.aborted) throw new Error('Query was cancelled.');
      if (runJson.error) {
        throw new Error(runJson.error);
      }
      const qid = runJson.query_id;
      if (typeof qid !== 'string' || qid.length === 0) {
        throw new Error('BTP /run returned no query_id');
      }
      // 2) GET /results/<qid> — already flattened: each row is a
      // per-trace result row with metadata columns and `_handle_idx`.
      const resultsResp = await fetch(`${this.endpoint}/results/${qid}`, {
        method: 'GET',
        signal,
      });
      if (!resultsResp.ok) {
        const text = await resultsResp.text().catch(() => '');
        throw new Error(
          `GET /results/${qid} failed: HTTP ${resultsResp.status} ${text}`,
        );
      }
      const rows = (await resultsResp.json()) as DataGridRow[];
      if (signal.aborted) throw new Error('Query was cancelled.');
      this.cachedRows = rows;
      return rows;
    })();
    try {
      return await this.fetchPromise;
    } catch (e) {
      // AbortError → translate to the same wording HttpDataSource uses
      // so the query page's check `e.message === 'Query was cancelled.'`
      // covers both backends.
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('Query was cancelled.');
      }
      throw e;
    } finally {
      this.fetchPromise = null;
      this.abortController = null;
    }
  }
}
