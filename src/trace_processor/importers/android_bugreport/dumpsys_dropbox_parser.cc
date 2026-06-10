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

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the entry list of "DUMP OF SERVICE dropbox:" (SDK >= 21, format
// stable since then):
//
//   Drop box contents: 52 entries
//   ...
//   2026-06-10 09:02:08 storage_trim (text, 16 bytes)
//   2026-06-10 09:02:09 system_server_strictmode (text, 1774 bytes)
//
// Each entry becomes an instant on the "Dropbox" track. Crash-ish tags
// (crashes, ANRs, watchdog) are the most interesting events in a bugreport,
// so the tag is used as the event name.
class DumpsysDropboxParser : public BugreportSectionParser {
 public:
  explicit DumpsysDropboxParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (line.StartsWith("Drop box contents: ")) {
      in_contents_ = true;
      return base::OkStatus();
    }
    if (!in_contents_ || line.size() < 20) {
      return base::OkStatus();
    }
    // "2026-06-10 09:02:08 tag (text, 16 bytes)".
    std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(line.substr(0, 19));
    if (!ts_ms || line.at(19) != ' ') {
      return base::OkStatus();
    }
    base::StringView rest = line.substr(20);
    size_t paren = rest.rfind('(');
    bool has_details = paren != base::StringView::npos && paren > 0 &&
                       rest.at(paren - 1) == ' ';
    base::StringView tag = has_details ? rest.substr(0, paren - 1) : rest;
    base::StringView details =
        has_details ? rest.substr(paren) : base::StringView();

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Dropbox";
    event.name = tag.ToStdString();
    if (!details.empty()) {
      event.args.emplace_back("entry", details.ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return base::OkStatus();
  }

 private:
  const BugreportParserDeps deps_;
  bool in_contents_ = false;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysDropboxParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysDropboxParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
