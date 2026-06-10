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

// Parses "DUMP OF SERVICE display:" (DisplayManagerService; same format for
// the "DUMP OF SERVICE CRITICAL display:" variant). As of SDK 36 (Baklava)
// the only wall-clock timestamped data are the DisplayPowerController
// BrightnessEvent ring buffers, printed as:
//
//   Automatic Brightness Adjustments Last 5 Events:
//     06-10 09:02:11.212 - BrightnessEvent: brt=0.39763778(83.0%), nits=-1.0,
//         lux=-1.0, reason=manual, strat=FallbackBrightnessStrategy,
//         state=ON, stateReason=DEFAULT_POLICY, policy=BRIGHT, flags=, ...,
//         physDisp=Built-in Screen(local:4619827353912518656), logicalId=0,
//         slowChange=false, rampSpeed=0.0
//
//   Reduce Bright Colors Adjustments Last 5 Events:
//     <same BrightnessEvent format>
//
// (events are single lines, wrapped here for readability; the format is
// BrightnessEvent.toString() prefixed with "MM-dd HH:mm:ss.SSS - "). Each
// becomes an instant on the "Display" track named "brightness=<brt>".
// Empty buffers print "No Automatic Brightness Adjustments" / "No Reduce
// Bright Colors Adjustments" instead (the automatic-brightness buffer is
// only allocated when auto-brightness is configured, so e.g. cuttlefish
// dumps contain no events at all).
//
// Everything else in the dump is skipped: it is point-in-time state with no
// timestamps ("Display States", "Display Power Controller *", brightness
// config/splines, "BrightnessTracker state" with mEvents.size=0) or
// elapsedRealtime-relative ("-1 (1208287 ms ago)") with no wall-clock anchor
// to convert against.
class DumpsysDisplayParser : public BugreportSectionParser {
 public:
  explicit DumpsysDisplayParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (!deps_.format->dumpstate_start_ms)
      return base::OkStatus();  // No reference time: cannot derive years.
    base::StringView trimmed = TrimLeft(line);
    if (trimmed.StartsWith("Automatic Brightness Adjustments Last ")) {
      source_ = "auto-brightness";
      return base::OkStatus();
    }
    if (trimmed.StartsWith("Reduce Bright Colors Adjustments Last ")) {
      source_ = "reduce-bright-colors";
      return base::OkStatus();
    }
    size_t marker = trimmed.find(" - BrightnessEvent: ");
    if (marker != base::StringView::npos)
      ParseBrightnessEvent(trimmed, marker);
    return base::OkStatus();
  }

 private:
  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && (sv.at(i) == ' ' || sv.at(i) == '\t'))
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

  // Returns the value of a ", key=" field, up to the next ", " separator.
  // Values never contain ", " themselves (e.g. "manual [ dim ]" is safe).
  static base::StringView Field(base::StringView s, base::StringView key) {
    size_t pos = s.find(key);
    if (pos == base::StringView::npos)
      return base::StringView();
    pos += key.size();
    size_t end = s.find(", ", pos);
    return s.substr(pos,
                    end == base::StringView::npos ? s.size() - pos : end - pos);
  }

  // `rec` is the left-trimmed "06-10 09:02:11.212 - BrightnessEvent: brt=..."
  // line; `marker` is the offset of " - BrightnessEvent: " within it.
  void ParseBrightnessEvent(base::StringView rec, size_t marker) {
    base::StringView ts = rec.substr(0, marker);
    size_t sp = ts.find(' ');
    if (sp == base::StringView::npos)
      return;
    std::optional<int64_t> ts_ms = ParseMonthDayTimeMs(
        ts.substr(0, sp), ts.substr(sp + 1), *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    base::StringView body = rec.substr(marker + 20);  // After ": ".
    base::StringView brt = Field(body, "brt=");
    if (brt.empty())
      return;
    // "0.39763778(83.0%)" / "0.5(user_set)(50%)" -> name keeps the raw value.
    size_t paren = brt.find('(');
    base::StringView brt_value =
        paren == base::StringView::npos ? brt : brt.substr(0, paren);

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Display";
    event.name = "brightness=" + brt_value.ToStdString();
    event.args.emplace_back("source", source_);
    event.args.emplace_back("brt", brt.ToStdString());
    static constexpr const char* kArgKeys[][2] = {
        {"display_id", ", logicalId="},
        {"reason", ", reason="},
        {"lux", ", lux="},
        {"nits", ", nits="},
        {"state", ", state="},
        {"policy", ", policy="},
        {"strategy", ", strat="},
        {"physical_display", ", physDisp="},
    };
    for (const auto& key : kArgKeys) {
      base::StringView value = Field(body, key[1]);
      if (!value.empty())
        event.args.emplace_back(key[0], value.ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  // Which ring buffer the current lines belong to (last header seen).
  std::string source_ = "unknown";
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysDisplayParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysDisplayParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
