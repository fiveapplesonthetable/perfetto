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

// Parses "DUMP OF SERVICE app_hibernation:", as printed on SDK 36 (Baklava,
// BP4A.251205.006):
//
//   User Level Hibernation States, user=0
//     UserLevelState{packageName='com.android.calendar', hibernated=false',
//     savedByte=0', lastUnhibernated=2026-06-10 09:02:03}
//   ...
//   Global Level Hibernation States
//   GlobalLevelState{packageName='com.android.calendar', hibernated=false',
//   savedByte=0', lastUnhibernated=1970-01-01}
//
// (the stray quotes after false'/0' are verbatim toString() artifacts; lines
// are not actually wrapped). Each UserLevelState with a real lastUnhibernated
// becomes a kInstant on the "App hibernation" track named after the package.
//
// UserLevelState.toString() formats the underlying lastUnhibernatedMs epoch
// value with SimpleDateFormat("yyyy-MM-dd HH:mm:ss"), i.e. in the device's
// LOCAL timezone - exactly the wall-clock ms the emitter expects, so unlike
// the raw mCreationTimeMs epoch field in dumpsys_notification_parser.cc no
// timezone adjustment is needed here. Packages never unhibernated print the
// epoch ("1970-01-01 00:00:00", possibly tz-shifted) and are skipped.
// GlobalLevelState lines only carry a date (day resolution) and are skipped
// as well.
class DumpsysAppHibernationParser : public BugreportSectionParser {
 public:
  explicit DumpsysAppHibernationParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (!t.StartsWith("UserLevelState{packageName='")) {
      return base::OkStatus();
    }
    base::StringView rest = t.substr(28);
    size_t name_end = rest.find('\'');
    if (name_end == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView package = rest.substr(0, name_end);

    size_t ts_pos = rest.find("lastUnhibernated=");
    if (ts_pos == base::StringView::npos) {
      return base::OkStatus();
    }
    std::optional<int64_t> ts_ms =
        ParseIsoDateTimeMs(rest.substr(ts_pos + 17, 19));
    // Skip "never unhibernated" placeholders (epoch 0, give or take a tz
    // offset): anything before 2000-01-01 is not a real event.
    constexpr int64_t kMinValidMs = 946684800000;  // 2000-01-01 00:00:00 UTC.
    if (!ts_ms || *ts_ms < kMinValidMs) {
      return base::OkStatus();
    }

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "App hibernation";
    event.name = package.ToStdString();
    base::StringView hibernated = Field(rest, "hibernated=", '\'');
    if (!hibernated.empty()) {
      event.args.emplace_back("hibernated", hibernated.ToStdString());
    }
    event.args.emplace_back("type", "lastUnhibernated");
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return base::OkStatus();
  }

 private:
  // Returns the value between `key` and the next `delim` ("" on miss).
  static base::StringView Field(base::StringView t,
                                base::StringView key,
                                char delim) {
    size_t b = t.find(key);
    if (b == base::StringView::npos) {
      return base::StringView();
    }
    b += key.size();
    size_t e = t.find(delim, b);
    if (e == base::StringView::npos) {
      return base::StringView();
    }
    return t.substr(b, e - b);
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  const BugreportParserDeps deps_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysAppHibernationParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysAppHibernationParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
