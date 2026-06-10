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
#include <vector>

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

// Parses "DUMP OF SERVICE power:" (and the identical-format "DUMP OF SERVICE
// CRITICAL power:" variant). As of SDK 36 (Baklava) two sub-blocks carry
// wall-clock timestamps:
//
//   Suspend Blockers: size=5
//     PowerManagerService.Display: ref count=1 [holding display: (06-10
//     09:01:58.386)]
//
//   Wake Lock Log
//     06-10 09:02:09.144 - 1000 (System) - ACQ WiredAccessoryManager (partial)
//     06-10 09:02:09.785 - 1000 (System) - REL WiredAccessoryManager
//
// Held suspend blockers become slices on "Power: suspend blockers" spanning
// from the hold time to dumpstate start. Wake lock ACQ/REL pairs (matched
// LIFO on owner+tag, falling back to tag only as the attributed owner can
// change between acquire and release) become slices on "Power: wake locks";
// unmatched entries become instants. Fields such as mLastWakeTime /
// mLastSleepTime / mLastUserActivityTime are skipped: they are
// elapsedRealtime-based ("62074 (1146439 ms ago)") and the dump prints no
// wall-clock/elapsed anchor pair to convert them reliably.
class DumpsysPowerParser : public BugreportSectionParser {
 public:
  explicit DumpsysPowerParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (!deps_.format->dumpstate_start_ms)
      return base::OkStatus();  // No reference time: cannot derive years.
    if (line.StartsWith("Suspend Blockers:")) {
      in_suspend_blockers_ = true;
      return base::OkStatus();
    }
    base::StringView trimmed = TrimLeft(line);
    if (in_suspend_blockers_) {
      if (trimmed.find(": ref count=") == base::StringView::npos) {
        in_suspend_blockers_ = false;
      } else {
        ParseSuspendBlocker(trimmed);
        return base::OkStatus();
      }
    }
    if (!trimmed.empty() && trimmed.at(0) >= '0' && trimmed.at(0) <= '9')
      ParseWakeLockLogLine(trimmed);
    return base::OkStatus();
  }

  base::Status EndOfSection() override {
    // Wake locks still held when the log was dumped: end unknown -> instants.
    for (const auto& lock : open_locks_) {
      BugreportTimelineEvent event;
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.track = "Power: wake locks";
      event.name = lock.tag;
      event.args.emplace_back("owner", lock.owner);
      if (!lock.flags.empty())
        event.args.emplace_back("flags", lock.flags);
      event.args.emplace_back("marker", "ACQ (no matching REL)");
      deps_.emitter->Emit(lock.start_ms, std::move(event));
    }
    open_locks_.clear();
    return base::OkStatus();
  }

 private:
  struct OpenLock {
    std::string owner;  // "1000 (System)".
    std::string tag;
    std::string flags;  // "partial".
    int64_t start_ms;
  };

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  // Parses an "MM-DD HH:MM:SS.mmm" timestamp into wall-clock ms. The year is
  // not printed; it is derived from the dumpstate start time, picking the
  // year that puts the event at or before dumpstate start (December events in
  // a January bugreport belong to the previous year).
  static std::optional<int64_t> ParseMonthDayTimeMs(base::StringView date,
                                                    base::StringView clock,
                                                    int64_t ref_ms) {
    if (date.size() != 5 || date.at(2) != '-')
      return std::nullopt;
    for (size_t i : {0u, 1u, 3u, 4u}) {
      if (date.at(i) < '0' || date.at(i) > '9')
        return std::nullopt;
    }
    int month = (date.at(0) - '0') * 10 + (date.at(1) - '0');
    int day = (date.at(3) - '0') * 10 + (date.at(4) - '0');
    if (month < 1 || month > 12 || day < 1 || day > 31)
      return std::nullopt;
    time_t ref_s = static_cast<time_t>(ref_ms / 1000);
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

  // `entry` is "PowerManagerService.Display: ref count=1 [holding display:
  // (06-10 09:01:58.386)]" (left-trimmed). Blockers with ref count 0 have an
  // empty "[]" detail and no timestamp; they are skipped.
  void ParseSuspendBlocker(base::StringView entry) {
    size_t colon = entry.find(": ref count=");
    size_t open = entry.find('[');
    size_t close = entry.rfind(']');
    if (open == base::StringView::npos || close == base::StringView::npos ||
        close <= open + 1) {
      return;
    }
    base::StringView detail = entry.substr(open + 1, close - open - 1);
    size_t paren = detail.rfind('(');
    if (paren == base::StringView::npos || detail.at(detail.size() - 1) != ')')
      return;
    base::StringView ts = detail.substr(paren + 1, detail.size() - paren - 2);
    size_t sp = ts.find(' ');
    if (sp == base::StringView::npos)
      return;
    int64_t ref_ms = *deps_.format->dumpstate_start_ms;
    std::optional<int64_t> held_ms =
        ParseMonthDayTimeMs(ts.substr(0, sp), ts.substr(sp + 1), ref_ms);
    if (!held_ms || *held_ms > ref_ms)
      return;
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kSlice;
    event.track = "Power: suspend blockers";
    event.name = entry.substr(0, colon).ToStdString();
    event.dur_ns = (ref_ms - *held_ms) * 1000 * 1000;
    event.args.emplace_back("detail", detail.ToStdString());
    deps_.emitter->Emit(*held_ms, std::move(event));
  }

  // `rec` is the left-trimmed "06-10 09:02:09.144 - 1000 (System) - ACQ
  // WiredAccessoryManager (partial)" line ("REL <tag>" has no flags suffix).
  void ParseWakeLockLogLine(base::StringView rec) {
    size_t sep1 = rec.find(" - ");
    if (sep1 == base::StringView::npos)
      return;
    base::StringView ts = rec.substr(0, sep1);
    size_t sp = ts.find(' ');
    if (sp == base::StringView::npos)
      return;
    std::optional<int64_t> ts_ms = ParseMonthDayTimeMs(
        ts.substr(0, sp), ts.substr(sp + 1), *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    size_t sep2 = rec.find(" - ", sep1 + 3);
    if (sep2 == base::StringView::npos)
      return;
    std::string owner = rec.substr(sep1 + 3, sep2 - sep1 - 3).ToStdString();
    base::StringView rest = rec.substr(sep2 + 3);

    if (rest.StartsWith("ACQ ")) {
      base::StringView tag = rest.substr(4);
      std::string flags;
      size_t paren = tag.rfind('(');
      if (paren != base::StringView::npos && paren > 0 &&
          tag.at(paren - 1) == ' ' && tag.at(tag.size() - 1) == ')') {
        flags = tag.substr(paren + 1, tag.size() - paren - 2).ToStdString();
        tag = tag.substr(0, paren - 1);
      }
      open_locks_.push_back(OpenLock{std::move(owner), tag.ToStdString(),
                                     std::move(flags), *ts_ms});
      return;
    }
    if (!rest.StartsWith("REL "))
      return;
    std::string tag = rest.substr(4).ToStdString();

    // Find the matching ACQ: most recent with the same owner+tag, falling
    // back to tag only (the System uid may release on the app's behalf).
    auto match = open_locks_.rend();
    for (auto it = open_locks_.rbegin(); it != open_locks_.rend(); ++it) {
      if (it->tag != tag)
        continue;
      if (it->owner == owner) {
        match = it;
        break;
      }
      if (match == open_locks_.rend())
        match = it;
    }
    BugreportTimelineEvent event;
    event.track = "Power: wake locks";
    event.name = tag;
    if (match == open_locks_.rend()) {
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.args.emplace_back("owner", owner);
      event.args.emplace_back("marker", "REL (no matching ACQ)");
      deps_.emitter->Emit(*ts_ms, std::move(event));
      return;
    }
    event.kind = BugreportTimelineEvent::Kind::kSlice;
    event.dur_ns = (*ts_ms - match->start_ms) * 1000 * 1000;
    event.args.emplace_back("owner", match->owner);
    if (!match->flags.empty())
      event.args.emplace_back("flags", match->flags);
    int64_t start_ms = match->start_ms;
    open_locks_.erase(std::next(match).base());
    deps_.emitter->Emit(start_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  bool in_suspend_blockers_ = false;
  std::vector<OpenLock> open_locks_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysPowerParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysPowerParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
