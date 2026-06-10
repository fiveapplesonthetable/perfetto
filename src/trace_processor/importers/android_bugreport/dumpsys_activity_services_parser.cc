/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the services / providers blocks of "DUMP OF SERVICE activity:".
// Runs alongside DumpsysBroadcastsParser (broadcast history) and
// DumpsysActivityProcessesParser (process starts/exits, recent tasks,
// activity launches). Samples from SDK 36 (Baklava):
//
// "ACTIVITY MANAGER SERVICES (dumpsys activity services)":
//   * ServiceRecord{fc02a86 u0 com.android.providers.media.module/com.and...
//     app=ProcessRecord{c8aa09d 4069:com.android.providers.media.module/u0a99}
//     createTime=-19m29s451ms startingBgTimeout=--
//     lastActivity=-19m28s631ms restartTime=-19m28s631ms createdFromFg=true
// createTime is TimeUtils.formatDuration(createRealTime, nowReal) in
// ServiceRecord.dump(), i.e. relative to the dump time on the
// elapsedRealtime clock -> "Service starts" instants anchored at
// dumpstate start. The other fields are skipped: lastActivity /
// restartTime / executingStart move on every interaction (not start
// anchors), startingBgTimeout / nextRestartTime are future-scheduled and
// printed against the uptime clock. No "Short FGS" / mFgsStartTime lines
// were present in this dump (startForegroundCount=0 everywhere). The
// trailing "Connection bindings to services:" ConnectionRecords carry no
// timestamps.
//
// "ACTIVITY MANAGER CONTENT PROVIDERS (dumpsys activity providers)":
//   * ContentProviderRecord{9cf68a2 u0 com.android.providers.telephony/.Mm...
//     ...
//     Connections:
//       -> 4698:com.android.messaging/u0a78 s0/2 u2/3 +19m25s263ms
// The trailing duration is "nowReal - createTime" of the connection
// (ContentProviderConnection.toClientString), i.e. the connection age ->
// "Provider connections" instants at dumpstate start minus the age. The
// "authority to provider mappings" sub-lists have no times.
//
// Skipped blocks (no anchorable timestamps in this dump):
// - "ACTIVITY MANAGER PENDING INTENTS": PendingIntentRecord entries carry
//   uid/package/flags/intent only; the occasional
//   "allowlistDuration=d7e817:+30s0ms/..." is a duration parameter, not a
//   timestamp (whenElapsed only exists in the alarm dump).
// - "ACTIVITY MANAGER STICKY BROADCASTS" ("Sticky broadcasts for user -1:",
//   inside the BROADCAST STATE block): intent + extras snapshots, no times.
// - "ACTIVITY MANAGER BROADCAST STATS STATE": aggregate per-action counters
//   and total/max dispatch durations, no per-event times.
// - "ACTIVITY MANAGER URI PERMISSIONS": UriPermission entries only have
//   mode/owned/global flags.
// - "ACTIVITY MANAGER ALLOWED ASSOCIATION STATE": "(No association
//   restrictions)" placeholder.
// - "App Time Limits" / "ACTIVITY MANAGER ALLOWLIST": not present in the
//   SDK 36 dump examined.
class DumpsysActivityServicesParser : public BugreportSectionParser {
 public:
  explicit DumpsysActivityServicesParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.empty()) {
      return base::OkStatus();
    }
    if (t.size() == line.size()) {
      // Unindented: possibly a new "ACTIVITY MANAGER ..." sub-header.
      if (t.StartsWith("ACTIVITY MANAGER ")) {
        block_ = Block::kNone;
        if (t.StartsWith("ACTIVITY MANAGER SERVICES")) {
          block_ = Block::kServices;
        } else if (t.StartsWith("ACTIVITY MANAGER CONTENT PROVIDERS")) {
          block_ = Block::kProviders;
        }
        ctx_ = Context();
      }
      return base::OkStatus();
    }
    switch (block_) {
      case Block::kServices:
        return ParseServiceLine(t);
      case Block::kProviders:
        return ParseProviderLine(t);
      case Block::kNone:
        break;
    }
    return base::OkStatus();
  }

 private:
  enum class Block { kNone, kServices, kProviders };

  // Per-record context, reset at each record header.
  struct Context {
    bool active = false;
    std::string name;  // Service / provider component.
    std::string proc;  // App process name.
    std::string pid;
  };

  // "* ServiceRecord{fc02a86 u0 <component> c:android}" followed by
  // "app=ProcessRecord{c8aa09d 4069:<process>/u0a99}" and
  // "createTime=-19m29s451ms startingBgTimeout=--".
  base::Status ParseServiceLine(base::StringView t) {
    if (t.StartsWith("* ServiceRecord{")) {
      ctx_ = Context();
      ctx_.name = ThirdBraceToken(t.substr(16)).ToStdString();
      ctx_.active = !ctx_.name.empty();
      return base::OkStatus();
    }
    if (!ctx_.active) {
      return base::OkStatus();
    }
    if (t.StartsWith("app=ProcessRecord{")) {
      base::StringView rec = t.substr(18);
      size_t sp = rec.find(' ');
      size_t colon = sp == base::StringView::npos ? sp : rec.find(':', sp);
      size_t slash =
          colon == base::StringView::npos ? colon : rec.find('/', colon);
      if (slash != base::StringView::npos) {
        ctx_.pid = rec.substr(sp + 1, colon - sp - 1).ToStdString();
        ctx_.proc = rec.substr(colon + 1, slash - colon - 1).ToStdString();
      }
      return base::OkStatus();
    }
    if (!t.StartsWith("createTime=")) {
      return base::OkStatus();
    }
    base::StringView raw = TokenUntilSpace(t.substr(11));
    if (std::optional<int64_t> rel_ms = ParseAndroidDurationMs(raw)) {
      BugreportTimelineEvent event;
      event.track = "Service starts";
      event.name = ctx_.name;
      event.args.emplace_back("app", ctx_.proc);
      event.args.emplace_back("pid", ctx_.pid);
      event.args.emplace_back("create_time", raw.ToStdString());
      EmitRelativeToDump(*rel_ms, std::move(event));
    }
    ctx_ = Context();
    return base::OkStatus();
  }

  // "* ContentProviderRecord{9cf68a2 u0 <component>}" followed (under a
  // "Connections:" sub-header) by
  // "-> 4698:com.android.messaging/u0a78 s0/2 u2/3 +19m25s263ms".
  base::Status ParseProviderLine(base::StringView t) {
    if (t.StartsWith("* ContentProviderRecord{")) {
      ctx_ = Context();
      ctx_.name = ThirdBraceToken(t.substr(24)).ToStdString();
      ctx_.active = !ctx_.name.empty();
      return base::OkStatus();
    }
    if (!ctx_.active || !t.StartsWith("-> ")) {
      return base::OkStatus();
    }
    base::StringView raw = t.substr(t.rfind(' ') + 1);  // Connection age.
    if (raw.size() < 2 || raw.at(0) != '+') {
      return base::OkStatus();
    }
    if (std::optional<int64_t> age_ms = ParseAndroidDurationMs(raw)) {
      BugreportTimelineEvent event;
      event.track = "Provider connections";
      event.name = ctx_.name;
      event.args.emplace_back("client",
                              TokenUntilSpace(t.substr(3)).ToStdString());
      event.args.emplace_back("connected_for", raw.ToStdString());
      EmitRelativeToDump(-*age_ms, std::move(event));
    }
    return base::OkStatus();
  }

  void EmitRelativeToDump(int64_t rel_ms, BugreportTimelineEvent event) {
    if (!deps_.format->dumpstate_start_ms) {
      return;
    }
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    deps_.emitter->Emit(*deps_.format->dumpstate_start_ms + rel_ms,
                        std::move(event));
  }

  // "fc02a86 u0 <component>[} ...]": the third space-separated token,
  // stripped of a trailing '}'.
  static base::StringView ThirdBraceToken(base::StringView rec) {
    rec = rec.substr(0, rec.find('}'));
    size_t s1 = rec.find(' ');
    size_t s2 = s1 == base::StringView::npos ? s1 : rec.find(' ', s1 + 1);
    if (s2 == base::StringView::npos) {
      return base::StringView();
    }
    return TokenUntilSpace(rec.substr(s2 + 1));
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static base::StringView TokenUntilSpace(base::StringView sv) {
    return sv.substr(0, sv.find(' '));  // substr clamps npos.
  }

  const BugreportParserDeps deps_;
  Block block_ = Block::kNone;
  Context ctx_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysActivityServicesParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysActivityServicesParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
