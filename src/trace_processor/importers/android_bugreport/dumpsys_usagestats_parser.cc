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
#include <vector>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the event log of "DUMP OF SERVICE usagestats:". As of SDK 36
// (Baklava) the dump looks like (events wrapped here for readability, each
// is one line):
//
//   user=0
//     Last 24 hour events (timeRange="6/9/2026, 9:21 AM – ..." )
//       time="2026-06-10 09:02:11" type=DEVICE_SHUTDOWN package=android ...
//       time="2026-06-10 09:02:11" type=ACTIVITY_RESUMED
//           package=com.android.provision
//           class=com.android.provision.DefaultActivity instanceId=265771028
//           taskRootPackage=com.android.provision taskRootClass=... flags=0x0
//     In-memory daily stats
//       packages / ChooserCounts / configurations / event aggregations ...
//
// The same events can be dumped multiple times: the "Last 24 hour events"
// block and the per-interval "In-memory {daily,weekly,...} stats" blocks (via
// their "events" sub-block, present on older releases) overlap. To avoid
// duplicate timeline events we parse only ONE source: the "Last 24 hour
// events" block when present, falling back to the daily stats "events"
// sub-block otherwise.
//
// ACTIVITY_RESUMED events paired with the next ACTIVITY_PAUSED/STOPPED for
// the same package+class+instanceId become slices on the "App usage" track;
// other notable events become instants on "Usage events".
class DumpsysUsageStatsParser : public BugreportSectionParser {
 public:
  explicit DumpsysUsageStatsParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView trimmed = TrimLeft(line);
    size_t indent = line.size() - trimmed.size();

    if (trimmed.StartsWith("time=\"")) {
      bool parse = block_ == Block::kLast24hEvents ||
                   (block_ == Block::kDailyStats && in_events_subblock_ &&
                    !seen_last_24h_);
      if (parse) {
        ParseEventLine(trimmed);
      }
      return base::OkStatus();
    }

    // Block sub-headers are printed at 2-space indent under "user=N".
    if (indent == 2) {
      if (trimmed.StartsWith("Last 24 hour events")) {
        block_ = Block::kLast24hEvents;
        seen_last_24h_ = true;
      } else if (trimmed.StartsWith("In-memory daily stats")) {
        block_ = Block::kDailyStats;
        in_events_subblock_ = false;
      } else if (!trimmed.StartsWith("timeRange=")) {
        block_ = Block::kOther;
      }
    } else if (indent == 4 && block_ == Block::kDailyStats) {
      in_events_subblock_ = trimmed == "events";
    }
    return base::OkStatus();
  }

  base::Status EndOfSection() override {
    // RESUMED events that never saw a matching PAUSED/STOPPED -> instants.
    for (const auto& act : open_activities_) {
      BugreportTimelineEvent event;
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.track = "App usage";
      event.name = act.package;
      event.args.emplace_back("class", act.clazz);
      event.args.emplace_back("type", "ACTIVITY_RESUMED");
      deps_.emitter->Emit(act.start_ms, std::move(event));
    }
    open_activities_.clear();
    return base::OkStatus();
  }

 private:
  enum class Block { kOther, kLast24hEvents, kDailyStats };

  struct OpenActivity {
    std::string package;
    std::string clazz;
    std::string instance_id;
    int64_t start_ms;
  };

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static bool IsNotableType(base::StringView type) {
    static constexpr const char* kNotable[] = {
        "DEVICE_SHUTDOWN",        "DEVICE_STARTUP",       "SCREEN_INTERACTIVE",
        "SCREEN_NON_INTERACTIVE", "KEYGUARD_SHOWN",       "KEYGUARD_HIDDEN",
        "STANDBY_BUCKET_CHANGED", "CONFIGURATION_CHANGE", "USER_INTERACTION",
        "SHORTCUT_INVOCATION",    "CHOOSER_ACTION",       "NOTIFICATION_SEEN"};
    for (const char* t : kNotable) {
      if (type == t)
        return true;
    }
    return false;
  }

  // `line` is 'time="2026-06-10 09:02:11" type=X package=Y [class=Z ...]'.
  void ParseEventLine(base::StringView line) {
    constexpr size_t kPrefix = 6;  // strlen("time=\"")
    size_t quote = line.find('"', kPrefix);
    if (quote == base::StringView::npos)
      return;
    std::optional<int64_t> ts_ms =
        ParseIsoDateTimeMs(line.substr(kPrefix, quote - kPrefix));
    if (!ts_ms)
      return;

    // Tokenize the remaining space-separated key=value pairs.
    base::StringView type, package, clazz, instance_id;
    base::StringView rest = line.substr(quote + 1);
    while (!(rest = TrimLeft(rest)).empty()) {
      size_t sp = rest.find(' ');
      base::StringView tok =
          sp == base::StringView::npos ? rest : rest.substr(0, sp);
      rest = sp == base::StringView::npos ? base::StringView()
                                          : rest.substr(sp + 1);
      size_t eq = tok.find('=');
      if (eq == base::StringView::npos)
        continue;
      base::StringView key = tok.substr(0, eq);
      base::StringView value = tok.substr(eq + 1);
      if (key == "type") {
        type = value;
      } else if (key == "package") {
        package = value;
      } else if (key == "class") {
        clazz = value;
      } else if (key == "instanceId") {
        instance_id = value;
      }
    }
    if (type.empty() || package.empty())
      return;

    if (type == "ACTIVITY_RESUMED") {
      open_activities_.push_back(
          OpenActivity{package.ToStdString(), clazz.ToStdString(),
                       instance_id.ToStdString(), *ts_ms});
      return;
    }

    if (type == "ACTIVITY_PAUSED" || type == "ACTIVITY_STOPPED") {
      BugreportTimelineEvent event;
      event.track = "App usage";
      event.name = package.ToStdString();
      event.args.emplace_back("class", clazz.ToStdString());
      // Find the most recent matching RESUMED and close it as a slice.
      for (auto it = open_activities_.rbegin(); it != open_activities_.rend();
           ++it) {
        if (base::StringView(it->package) != package ||
            base::StringView(it->clazz) != clazz ||
            base::StringView(it->instance_id) != instance_id) {
          continue;
        }
        event.kind = BugreportTimelineEvent::Kind::kSlice;
        event.dur_ns = (*ts_ms - it->start_ms) * 1000 * 1000;
        event.args.emplace_back("type",
                                "ACTIVITY_RESUMED -> " + type.ToStdString());
        int64_t start_ms = it->start_ms;
        open_activities_.erase(std::next(it).base());
        deps_.emitter->Emit(start_ms, std::move(event));
        return;
      }
      // No matching RESUMED: emit as instant.
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.args.emplace_back("type", type.ToStdString());
      deps_.emitter->Emit(*ts_ms, std::move(event));
      return;
    }

    if (!IsNotableType(type))
      return;
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Usage events";
    event.name = type.ToStdString();
    event.args.emplace_back("package", package.ToStdString());
    if (!clazz.empty()) {
      event.args.emplace_back("class", clazz.ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  Block block_ = Block::kOther;
  bool in_events_subblock_ = false;
  bool seen_last_24h_ = false;
  std::vector<OpenActivity> open_activities_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysUsageStatsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysUsageStatsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
