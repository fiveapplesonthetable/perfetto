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

import './styles.scss';
import m from 'mithril';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {NUM} from '../../trace_processor/query_result';
import {BugreportPage} from './bugreport_page';
import {BugreportExplorerSession} from './session';

// Explorer for Android bugreport zips: a full-screen page to browse every
// dumpstate section and dumpsys service (structured via per-service renderers,
// or raw). The importer's timeline tracks (track type "android_bugreport")
// are grouped under "Bugreport" by dev.perfetto.TraceProcessorTrack.
export default class implements PerfettoPlugin {
  static readonly id = 'com.android.BugreportExplorer';
  static readonly description =
    'Bugreport Explorer: browse the dumpstate sections and dumpsys services ' +
    'of an Android bugreport, with structured per-service renderers and a ' +
    'raw text view.';

  async onTraceLoad(ctx: Trace): Promise<void> {
    const res = await ctx.engine.query(
      'SELECT count(*) AS cnt FROM android_dumpstate',
    );
    if (res.firstRow({cnt: NUM}).cnt === 0) return; // Not a bugreport.

    const session = new BugreportExplorerSession(ctx);
    await session.init();

    ctx.pages.registerPage({
      route: '/bugreport',
      render: () => m(BugreportPage, {session}),
    });
    ctx.sidebar.addMenuItem({
      section: 'current_trace',
      sortOrder: 40,
      text: 'Bugreport',
      href: '#!/bugreport',
      icon: 'bug_report',
    });
  }
}
