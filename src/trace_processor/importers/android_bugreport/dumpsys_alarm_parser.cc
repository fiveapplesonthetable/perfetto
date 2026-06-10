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

// Parses "DUMP OF SERVICE alarm:". As of SDK 36 (Baklava, BP4A.251205.006)
// three sub-blocks carry resolvable times for alarms that already happened
// (pending/future alarms are deliberately skipped):
//
//   Recent TIME_TICK history:
//     2026-06-10 09:21:00.000
//     2026-06-10 09:20:00.000
//
//   App Alarm history:
//     com.android.providers.calendar, u0: -19m22s759ms,
//
//   Removal history:
//     1000:
//       #1: Reason=pi_cancelled elapsed=-19m21s737ms rtc=2026-06-10
//       09:02:20.188
//         Snapshot:
//           type=RTC_WAKEUP tag=*walarm*:com.android.settings.battery...
//           policyWhenElapsed: requester=+38m18s75ms ...
//
// TIME_TICK entries and removal "rtc=" times are local wall-clock strings
// (SimpleDateFormat) and become kInstants on the "Alarms" track directly.
// "App Alarm history" (AppWakeupHistory.dump: per-package wakeup deliveries)
// prints times relative to the elapsed clock at dump time, approximated here
// with the dumpstate start time (same approximation as the jobscheduler
// parser). Unfilled TIME_TICK ring-buffer slots print "-" and end the block.
class DumpsysAlarmParser : public BugreportSectionParser {
 public:
  explicit DumpsysAlarmParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimRight(TrimLeft(line));
    if (t == "Recent TIME_TICK history:") {
      block_ = Block::kTickHistory;
      return base::OkStatus();
    }
    if (t == "App Alarm history:") {
      block_ = Block::kAppHistory;
      return base::OkStatus();
    }
    if (t == "Removal history:") {
      block_ = Block::kRemovalHistory;
      removal_uid_.clear();
      pending_removal_.reset();
      return base::OkStatus();
    }
    switch (block_) {
      case Block::kNone:
        break;
      case Block::kTickHistory: {
        std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(t);
        if (!ts_ms) {  // Blank line, "-" slot or unrelated line: block over.
          block_ = Block::kNone;
          break;
        }
        BugreportTimelineEvent event;
        event.kind = BugreportTimelineEvent::Kind::kInstant;
        event.track = "Alarms";
        event.name = "TIME_TICK";
        deps_.emitter->Emit(*ts_ms, std::move(event));
        break;
      }
      case Block::kAppHistory:
        if (!ParseAppHistoryLine(t))
          block_ = Block::kNone;
        break;
      case Block::kRemovalHistory:
        if (t.empty()) {
          block_ = Block::kNone;
          break;
        }
        ParseRemovalLine(t);
        break;
    }
    return base::OkStatus();
  }

 private:
  enum class Block { kNone, kTickHistory, kAppHistory, kRemovalHistory };

  struct PendingRemoval {
    std::string reason;
    int64_t rtc_ms;
  };

  // "<pkg>, u<user>: <dur1>, <dur2>, " with negative (in-the-past) durations
  // relative to the dump time. Returns false when `t` is not a history line.
  bool ParseAppHistoryLine(base::StringView t) {
    size_t comma = t.find(", u");
    if (comma == base::StringView::npos)
      return false;
    size_t colon = t.find(": ", comma);
    if (colon == base::StringView::npos)
      return false;
    if (!deps_.format->dumpstate_start_ms)
      return true;  // Recognized, but no anchor to place it on the timeline.
    std::string pkg = t.substr(0, comma).ToStdString();
    std::string user = t.substr(comma + 2, colon - comma - 2).ToStdString();
    base::StringView rest = t.substr(colon + 2);
    while (!rest.empty()) {
      size_t end = rest.find(',');
      base::StringView tok =
          TrimLeft(end == base::StringView::npos ? rest : rest.substr(0, end));
      rest = end == base::StringView::npos ? base::StringView()
                                           : rest.substr(end + 1);
      std::optional<int64_t> rel_ms = ParseAndroidDurationMs(tok);
      if (!rel_ms || *rel_ms > 0)
        continue;
      BugreportTimelineEvent event;
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.track = "Alarms";
      event.name = pkg;
      event.args.emplace_back("user", user);
      event.args.emplace_back("type", "wakeup delivery");
      deps_.emitter->Emit(*deps_.format->dumpstate_start_ms + *rel_ms,
                          std::move(event));
    }
    return true;
  }

  // Removal history lines (already trimmed): a "1000:" / "u0a23:" uid header,
  // a "#N: Reason=<reason> elapsed=<dur> rtc=<iso time>" entry, or its
  // "Snapshot:" / "type=<type> tag=<tag>" / "policyWhenElapsed: ..." detail.
  void ParseRemovalLine(base::StringView t) {
    if (t.at(t.size() - 1) == ':' && t.find(' ') == base::StringView::npos &&
        t.find('=') == base::StringView::npos && t != "Snapshot:" &&
        t != "policyWhenElapsed:") {
      removal_uid_ = t.substr(0, t.size() - 1).ToStdString();
      return;
    }
    size_t reason = t.find("Reason=");
    if (reason != base::StringView::npos) {
      size_t rtc = t.find(" rtc=", reason);
      size_t elapsed = t.find(" elapsed=", reason);
      if (rtc == base::StringView::npos || elapsed == base::StringView::npos ||
          elapsed < reason) {
        return;
      }
      std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(t.substr(rtc + 5));
      if (!ts_ms)
        return;
      pending_removal_ = PendingRemoval{
          t.substr(reason + 7, elapsed - reason - 7).ToStdString(), *ts_ms};
      return;
    }
    if (pending_removal_ && t.StartsWith("type=")) {
      size_t tag = t.find(" tag=");
      if (tag != base::StringView::npos) {
        BugreportTimelineEvent event;
        event.kind = BugreportTimelineEvent::Kind::kInstant;
        event.track = "Alarms";
        event.name = t.substr(tag + 5).ToStdString();
        event.args.emplace_back("type", "removed: " + pending_removal_->reason);
        event.args.emplace_back("alarm_type",
                                t.substr(5, tag - 5).ToStdString());
        if (!removal_uid_.empty())
          event.args.emplace_back("uid", removal_uid_);
        deps_.emitter->Emit(pending_removal_->rtc_ms, std::move(event));
      }
      pending_removal_.reset();
    }
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static base::StringView TrimRight(base::StringView sv) {
    size_t i = sv.size();
    while (i > 0 && sv.at(i - 1) == ' ')
      --i;
    return sv.substr(0, i);
  }

  const BugreportParserDeps deps_;
  Block block_ = Block::kNone;
  std::string removal_uid_;
  std::optional<PendingRemoval> pending_removal_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysAlarmParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysAlarmParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
