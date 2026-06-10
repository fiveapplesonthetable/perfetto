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

constexpr size_t kMaxEventNameLen = 120;

// Parses the EventLogger blocks of "DUMP OF SERVICE audio:". AudioService
// keeps a ring buffer of recent events per subsystem and dumps each one via
// com.android.server.utils.EventLogger.dump() as a titled block of
// timestamped lines. As of SDK 36 (Baklava):
//
//   Events log: audio services lifecycle
//   06-10 09:02:08:481 AudioService()
//   06-10 09:02:08:511 Controller start task complete
//   ...
//   Events log: force use (logged before setForceUse() is executed)
//   06-10 09:02:08:525 setForceUse(FOR_ENCODED_SURROUND, FORCE_NONE) due to
//       readPersistedSettings
//
// (entries are single lines, wrapped here for readability.) The timestamp is
// SimpleDateFormat("MM-dd HH:mm:ss:SSS") -- note the COLON before the millis;
// older releases (pre-T AudioEventLogger) print the same shape but '.' is
// also accepted in case the separator drifts. The year is not printed and is
// derived from the dumpstate start time.
//
// Older releases title each block with a plain "<title>:" line instead of
// the "Events log: " prefix (added in T when AudioEventLogger was rewritten
// as EventLogger); a line ending in ':' immediately preceding a timestamped
// entry is therefore also accepted as a block header.
//
// Each entry becomes an instant on the "Audio" track named after the event
// text, with the owning block title as the "category" arg.
class DumpsysAudioParser : public BugreportSectionParser {
 public:
  explicit DumpsysAudioParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.StartsWith("Events log:")) {
      category_ = TrimHeader(t.substr(11));
      prev_colon_header_.clear();
      return base::OkStatus();
    }
    if (MaybeParseEntry(t)) {
      prev_colon_header_.clear();
      return base::OkStatus();
    }
    // Fallback for pre-T dumps: a "<title>:" line directly above the first
    // timestamped entry of a block acts as its header.
    if (!t.empty() && t.at(t.size() - 1) == ':') {
      prev_colon_header_ = TrimHeader(t);
    } else {
      prev_colon_header_.clear();
    }
    return base::OkStatus();
  }

 private:
  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  // Strips leading spaces and one trailing ':' from a block header.
  static std::string TrimHeader(base::StringView sv) {
    std::string s = TrimLeft(sv).ToStdString();
    if (!s.empty() && s.back() == ':')
      s.pop_back();
    return s;
  }

  static bool IsDigit(char c) { return c >= '0' && c <= '9'; }

  // Parses an EventLogger timestamp split into `date` ("06-10") and `clock`
  // ("09:02:08.481", millis separator already normalized to '.') into
  // wall-clock ms. The year is not printed; it is derived from the dumpstate
  // start time, picking the year that puts the event at or before dumpstate
  // start (events from last December in a bugreport taken in January belong
  // to the previous year).
  static std::optional<int64_t> ParseEntryTimeMs(base::StringView date,
                                                 base::StringView clock,
                                                 int64_t dumpstate_start_ms) {
    int month = (date.at(0) - '0') * 10 + (date.at(1) - '0');
    int day = (date.at(3) - '0') * 10 + (date.at(4) - '0');
    if (month < 1 || month > 12 || day < 1 || day > 31)
      return std::nullopt;

    time_t ref_s = static_cast<time_t>(dumpstate_start_ms / 1000);
    struct tm* ref_tm = gmtime(&ref_s);
    if (!ref_tm)
      return std::nullopt;
    int year = ref_tm->tm_year + 1900;
    if (month > ref_tm->tm_mon + 1)
      --year;  // December/January wraparound.

    base::StackString<40> iso("%04d-%.*s %.*s", year,
                              static_cast<int>(date.size()), date.data(),
                              static_cast<int>(clock.size()), clock.data());
    return ParseIsoDateTimeMs(iso.string_view());
  }

  // Returns true if `t` (left-trimmed) is a timestamped EventLogger entry,
  // i.e. "MM-DD HH:MM:SS:mmm <text>" (or '.' before the millis), emitting an
  // instant for it. Malformed lines are silently skipped (returns false).
  bool MaybeParseEntry(base::StringView t) {
    // "MM-DD HH:MM:SS?mmm" is 18 chars; entries with empty text are dropped.
    if (t.size() < 19 || !deps_.format->dumpstate_start_ms)
      return false;
    static constexpr size_t kDigits[] = {0,  1,  3,  4,  6,  7, 9,
                                         10, 12, 13, 15, 16, 17};
    for (size_t i : kDigits) {
      if (!IsDigit(t.at(i)))
        return false;
    }
    char ms_sep = t.at(14);
    if (t.at(2) != '-' || t.at(5) != ' ' || t.at(8) != ':' || t.at(11) != ':' ||
        (ms_sep != ':' && ms_sep != '.') || t.at(18) != ' ') {
      return false;
    }

    base::StackString<16> clock("%.*s.%.*s", 8, t.data() + 6, 3, t.data() + 15);
    std::optional<int64_t> ts_ms = ParseEntryTimeMs(
        t.substr(0, 5), clock.string_view(), *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return false;

    base::StringView text = TrimLeft(t.substr(19));
    if (text.empty())
      return false;
    if (!prev_colon_header_.empty())
      category_ = prev_colon_header_;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Audio";
    event.name = text.substr(0, kMaxEventNameLen).ToStdString();
    if (!category_.empty())
      event.args.emplace_back("category", category_);
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return true;
  }

  const BugreportParserDeps deps_;
  // Title of the EventLogger block the parser is currently inside.
  std::string category_;
  // Set when the previous line ended with ':' (old-style block header
  // candidate); consumed by the next timestamped entry.
  std::string prev_colon_header_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysAudioParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysAudioParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
