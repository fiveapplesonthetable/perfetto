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
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the per-namespace "Historical operations" blocks of "DUMP OF
// SERVICE settings:", as printed on SDK 36 (Baklava, BP4A.251205.006). Each
// settings namespace dump ("CONFIG SETTINGS (user 0)", "GLOBAL SETTINGS
// (user 0)", "SECURE SETTINGS (user 0)", "SYSTEM SETTINGS (user 0)") ends
// with SettingsState's recent-mutation ring buffer:
//
//   GLOBAL SETTINGS (user 0)
//   version: 231
//   _id:115 name:adb_wifi_enabled pkg:android value:0 ...
//   ...
//   Historical operations
//   2026-06-10 09:02:30 persist
//   2026-06-10 09:02:30 update watch_ranging_available
//   2026-06-10 09:02:12 update adb_enabled
//   2026-06-10 09:02:04 initialize
//
// Lines are "<iso wall-clock ts> <operation>[ <setting>]"; the setting part
// is absent for namespace-wide operations ("persist", "initialize"). Each
// line becomes a kInstant on the "Settings" track named after the setting
// (or the operation when there is none), with the namespace tracked from the
// preceding "<NAMESPACE> SETTINGS (user <N>)" header.
class DumpsysSettingsParser : public BugreportSectionParser {
 public:
  explicit DumpsysSettingsParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    // Namespace header: "SECURE SETTINGS (user 0)" (no indent).
    size_t hdr = line.find(" SETTINGS (user ");
    if (hdr != base::StringView::npos && !line.empty() && line.at(0) != ' ') {
      namespace_ = line.substr(0, hdr).ToStdString();
      size_t user_start = hdr + 16;
      size_t user_end = line.find(')', user_start);
      user_ =
          user_end == base::StringView::npos
              ? ""
              : line.substr(user_start, user_end - user_start).ToStdString();
      in_history_ = false;
      return base::OkStatus();
    }
    if (line == "Historical operations") {
      in_history_ = true;
      return base::OkStatus();
    }
    if (!in_history_) {
      return base::OkStatus();
    }
    // "2026-06-10 09:02:30 update watch_ranging_available".
    if (line.size() < 21 || line.at(19) != ' ') {
      in_history_ = false;  // Blank line / next sub-section ends the block.
      return base::OkStatus();
    }
    std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(line.substr(0, 19));
    if (!ts_ms) {
      in_history_ = false;
      return base::OkStatus();
    }
    base::StringView rest = line.substr(20);
    size_t space = rest.find(' ');
    base::StringView operation =
        space == base::StringView::npos ? rest : rest.substr(0, space);
    base::StringView setting = space == base::StringView::npos
                                   ? base::StringView()
                                   : rest.substr(space + 1);

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Settings";
    event.name =
        setting.empty() ? operation.ToStdString() : setting.ToStdString();
    if (!namespace_.empty()) {
      event.args.emplace_back("namespace", namespace_);
    }
    event.args.emplace_back("operation", operation.ToStdString());
    if (!user_.empty()) {
      event.args.emplace_back("user", user_);
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return base::OkStatus();
  }

 private:
  const BugreportParserDeps deps_;
  std::string namespace_;
  std::string user_;
  bool in_history_ = false;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysSettingsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysSettingsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
