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
#include <ctime>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_utils.h"
#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Names longer than this are truncated; full text goes in the "message" arg.
constexpr size_t kMaxNameLen = 120;

// Parses "DUMP OF SERVICE bluetooth_manager:". As of SDK 36 (Baklava) the
// dump carries two timestamped history formats that the catch-all event-log
// parser misses (its LocalLog idiom requires a " - " separator; the
// StateMachine "rec[N]:" records in this dump *are* already covered by it):
//
// 1. Year-less "MM-DD HH:MM:SS.mmm <message>" entries with a plain space (or
//    tab) before the message, printed by BluetoothManagerService's enable
//    log and by various profile event logs. Verbatim samples:
//      Enable log:
//        06-10 09:02:09.543 \tPackage [android] requested to [Enable]. \t...
//      Scan Mode Changes:
//        06-10 09:02:10.256 processProfileServiceStateChanged: SCAN_MODE_...
//      TbsGatt instance (CCID= 1) event log:
//        06-10 09:02:10.191 Initialized
//
// 2. Native stack (bluetooth "shim") history blocks, "<tag>  <iso ts>
//    <message>" where the tag contains "::". Verbatim samples:
//      shim::btm  2026-06-10 09:02:10.096 Initialized btm history
//      shim::btm  2026-06-10 09:02:10.177 RFCOMM Server started : ff:ff:...
//      ::le_audio  2026-06-10 09:02:10.249 Initialized le_audio history
//
// Both become instants on the "Bluetooth" track. The year of format 1 is
// derived from the dumpstate start time. Unrecognized lines are skipped
// silently; this parser never fails import.
class DumpsysBluetoothManagerParser : public BugreportSectionParser {
 public:
  explicit DumpsysBluetoothManagerParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView trimmed = TrimLeft(line);
    if (trimmed.empty())
      return base::OkStatus();
    char c = trimmed.at(0);
    if (c < '0' || c > '9') {
      // Bare "MM-DD HH:MM:SS.mmm <msg>" lines (enable log, GATT event logs)
      // are handled by the catch-all event log parser's bare-timestamp
      // idiom; this parser only covers the native-stack shim history lines,
      // whose "<tag>  <iso ts> <msg>" shape the catch-all cannot see.
      ParseShimHistoryLine(trimmed);
    }
    return base::OkStatus();
  }

 private:
  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && (sv.at(i) == ' ' || sv.at(i) == '\t'))
      ++i;
    return sv.substr(i);
  }

  void EmitInstant(int64_t ts_ms, base::StringView msg, base::StringView tag) {
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Bluetooth";
    event.name = msg.substr(0, kMaxNameLen).ToStdString();
    // The enable log embeds tabs inside the message; normalize for display.
    for (char& c : event.name) {
      if (c == '\t')
        c = ' ';
    }
    if (!tag.empty())
      event.args.emplace_back("tag", tag.ToStdString());
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg.ToStdString());
    deps_.emitter->Emit(ts_ms, std::move(event));
  }

  // Format: "shim::btm  2026-06-10 09:02:10.096 <message>".
  void ParseShimHistoryLine(base::StringView t) {
    size_t sp = t.find(' ');
    if (sp == base::StringView::npos || sp == 0)
      return;
    base::StringView tag = t.substr(0, sp);
    if (tag.find("::") == base::StringView::npos)
      return;
    base::StringView rest = TrimLeft(t.substr(sp));
    // "YYYY-MM-DD HH:MM:SS.mmm" is 23 chars.
    if (rest.size() < 24 || rest.at(4) != '-' || rest.at(7) != '-' ||
        rest.at(10) != ' ' || rest.at(19) != '.' || rest.at(23) != ' ') {
      return;
    }
    std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(rest.substr(0, 23));
    if (!ts_ms)
      return;
    base::StringView msg = TrimLeft(rest.substr(24));
    if (msg.empty())
      return;
    EmitInstant(*ts_ms, msg, tag);
  }

  const BugreportParserDeps deps_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysBluetoothManagerParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysBluetoothManagerParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
