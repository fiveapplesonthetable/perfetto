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

// Parses the "AppOps Uid Op State" block of "DUMP OF SERVICE appops:", as
// printed on SDK 36 (Baklava):
//
//   AppOps Uid Op State
//     Uid 1000:
//       state=pers
//       Package android:
//         MONITOR_LOCATION (allow / switch COARSE_LOCATION=allow):
//           SensorNotificationService=[
//             Access: [pers-s] 2026-06-10 09:02:11.265 (-19m32s600ms)
//             duration=+19m32s603ms Reject: [pers-s]2026-06-10 09:02:10.562
//             (-19m33s303ms) Running start at: +19m32s600ms
//           ]
//
// Context (uid / package / op name) is tracked by indentation. Each
// "Access:" line becomes an event on the "AppOps" track: a slice when a
// "duration=" suffix is present, an instant otherwise. "Reject:" lines (note:
// no space after the state flag) become instants, and "Running start at:"
// lines (ops still held when the service was dumped) become instants at the
// start of the current run, anchored to the dumpstate start time.
class DumpsysAppOpsParser : public BugreportSectionParser {
 public:
  explicit DumpsysAppOpsParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    size_t indent = line.size() - t.size();

    // Context lines: "  Uid u0a107:" / "    Package com.foo:" /
    // "      COARSE_LOCATION (allow): ".
    if (indent == 2 && t.StartsWith("Uid ") && EndsWithColon(t)) {
      uid_ = t.substr(4, t.size() - 5).ToStdString();
      package_.clear();
      op_.clear();
      return base::OkStatus();
    }
    if (indent == 4 && t.StartsWith("Package ") && EndsWithColon(t)) {
      package_ = t.substr(8, t.size() - 9).ToStdString();
      op_.clear();
      return base::OkStatus();
    }
    if (indent == 6) {
      size_t paren = t.find(" (");
      size_t close =
          paren == base::StringView::npos ? paren : t.find("):", paren);
      if (paren != base::StringView::npos && close != base::StringView::npos &&
          t.substr(0, paren).find(' ') == base::StringView::npos) {
        op_ = t.substr(0, paren).ToStdString();
      }
      return base::OkStatus();
    }

    if (op_.empty()) {
      return base::OkStatus();
    }
    if (t.StartsWith("Access: [")) {
      return ParseAccessLine(t, /*is_reject=*/false);
    }
    if (t.StartsWith("Reject: [")) {
      return ParseAccessLine(t, /*is_reject=*/true);
    }
    if (t.StartsWith("Running start at: ")) {
      return ParseRunningLine(t);
    }
    return base::OkStatus();
  }

 private:
  // "Access: [pers-s] 2026-06-10 09:02:11.285 (-19m32s580ms) duration=+181ms"
  // "Reject: [bg-s]2026-06-10 09:02:14.008 (-19m29s857ms)"
  base::Status ParseAccessLine(base::StringView t, bool is_reject) {
    size_t bracket = t.find(']', 9);
    if (bracket == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView state = t.substr(9, bracket - 9);
    base::StringView rest = TrimLeft(t.substr(bracket + 1));

    size_t paren = rest.find(" (");
    if (paren == base::StringView::npos) {
      return base::OkStatus();
    }
    std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(rest.substr(0, paren));
    if (!ts_ms) {
      return base::OkStatus();
    }
    size_t paren_end = rest.find(')', paren);
    if (paren_end == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView rel = rest.substr(paren + 2, paren_end - paren - 2);

    std::optional<int64_t> dur_ms;
    size_t dur_pos = rest.find("duration=", paren_end);
    if (dur_pos != base::StringView::npos) {
      dur_ms = ParseAndroidDurationMs(rest.substr(dur_pos + 9));
    }

    BugreportTimelineEvent event = MakeEvent(state, rel);
    event.args.emplace_back("type", is_reject ? "Reject" : "Access");
    if (dur_ms && !is_reject) {
      event.kind = BugreportTimelineEvent::Kind::kSlice;
      event.dur_ns = *dur_ms * 1000 * 1000;
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return base::OkStatus();
  }

  // "Running start at: +19m32s600ms": the op is still held; the value is how
  // long it has been running for at dump time.
  base::Status ParseRunningLine(base::StringView t) {
    std::optional<int64_t> running_ms = ParseAndroidDurationMs(t.substr(18));
    if (!running_ms || !deps_.format->dumpstate_start_ms) {
      return base::OkStatus();
    }
    BugreportTimelineEvent event = MakeEvent(base::StringView(), t.substr(18));
    event.args.emplace_back("type", "Running start");
    deps_.emitter->Emit(*deps_.format->dumpstate_start_ms - *running_ms,
                        std::move(event));
    return base::OkStatus();
  }

  BugreportTimelineEvent MakeEvent(base::StringView state,
                                   base::StringView rel) {
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "AppOps";
    event.name = op_;
    event.args.emplace_back("package", package_);
    event.args.emplace_back("uid", uid_);
    if (!state.empty()) {
      event.args.emplace_back("state", state.ToStdString());
    }
    event.args.emplace_back("relative_time", rel.ToStdString());
    return event;
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static bool EndsWithColon(base::StringView sv) {
    return !sv.empty() && sv.at(sv.size() - 1) == ':';
  }

  const BugreportParserDeps deps_;
  std::string uid_;
  std::string package_;
  std::string op_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysAppOpsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysAppOpsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
