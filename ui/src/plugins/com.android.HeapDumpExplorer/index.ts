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
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {App} from '../../public/app';
import {NUM} from '../../trace_processor/query_result';
import HeapProfilePlugin from '../dev.perfetto.HeapProfile';
import {HeapDumpPage} from './heap_dump_page';
import {HeapDumpExplorerSession} from './session';

/**
 * Holds the single live {@link HeapDumpExplorerSession} (or null) so
 * that `static onActivate` and the per-trace `onTraceLoad` can share
 * one reference across the plugin's lifetime. Replaces a bag of
 * ad-hoc module-level `let` and `static` fields.
 *
 * The render callback registered with `app.pages.registerPage` is
 * created in `onActivate` and outlives any individual trace, so it
 * has to read the session through some indirection. This registry
 * is that indirection — a single, intentional, well-named singleton
 * rather than a scattering of mutable globals.
 */
class SessionRegistry {
  private current: HeapDumpExplorerSession | null = null;

  set(session: HeapDumpExplorerSession): void {
    this.current = session;
  }

  get(): HeapDumpExplorerSession | null {
    return this.current;
  }
}

const sessionRegistry = new SessionRegistry();

export default class implements PerfettoPlugin {
  static readonly id = 'com.android.HeapDumpExplorer';
  static readonly dependencies = [HeapProfilePlugin];

  static onActivate(app: App): void {
    app.pages.registerPage({
      route: '/heapdump',
      render: (subpage) =>
        m(HeapDumpPage, {session: sessionRegistry.get(), subpage}),
    });
  }

  async onTraceLoad(ctx: Trace): Promise<void> {
    const res = await ctx.engine.query(
      'SELECT count(*) AS cnt FROM heap_graph_object LIMIT 1',
    );
    const cnt = res.iter({cnt: NUM}).cnt;
    if (cnt === 0) return;

    const session = new HeapDumpExplorerSession(ctx, ctx.engine);
    sessionRegistry.set(session);

    ctx.plugins
      .getPlugin(HeapProfilePlugin)
      .registerOnNodeSelectedListener(({pathHashes, isDominator}) =>
        session.openFlamegraph({pathHashes, isDominator}),
      );

    ctx.sidebar.addMenuItem({
      section: 'current_trace',
      sortOrder: 30,
      text: 'Heapdump Explorer',
      href: '#!/heapdump',
      icon: 'memory',
    });
  }
}
