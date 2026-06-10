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

// Parses "DUMP OF SERVICE sensorservice:" (and the identically-formatted
// "DUMP OF SERVICE CRITICAL sensorservice:" variant). As of SDK 36 (Baklava)
// two sub-blocks carry wall-clock timestamps:
//
//   Recent Sensor events:
//   Proximity Sensor: last 1 events
//   <tab> 1 (ts=61.784559233, wall=09:02:11.325) 2.50, 0.00, 0.00,
//
//   Previous Registrations:
//   09:02:11 + 0x00000007 pid= 3335 uid=10088 samplingPeriod=  200000us
//       batchingPeriod=       0us result=OK (sensor, package): (Proximity
//       Sensor           , com.android.systemui...ThresholdSensorImpl$1)
//
// (registration entries are single lines, wrapped here for readability; the
// "+" is an activation, "-" a deactivation whose periods print as "N/A").
// Both become instants on the "Sensors" track: recent events named after the
// sensor, registrations named "activate/deactivate <sensor>".
//
// Wall times are time-of-day only; the date is taken from dumpstate start
// (see ParseDayClockMs). The "ts=" seconds are elapsedRealtime-based and only
// kept as an arg. Skipped because they carry no usable timestamps: the
// "Sensor List" / "Fusion States" / connection blocks (point-in-time state)
// and the "Captured at: HH:MM:SS.mmm" header.
class DumpsysSensorServiceParser : public BugreportSectionParser {
 public:
  explicit DumpsysSensorServiceParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (!deps_.format->dumpstate_start_ms)
      return base::OkStatus();  // No reference time: cannot derive dates.
    if (IsRegistrationLine(line)) {
      ParseRegistration(line);
      return base::OkStatus();
    }
    if (line.StartsWith("Recent Sensor events:")) {
      in_recent_events_ = true;
      return base::OkStatus();
    }
    if (!in_recent_events_)
      return base::OkStatus();
    if (line.StartsWith("\t")) {
      ParseRecentEvent(TrimLeft(line));
    } else if (line.EndsWith(" events") &&
               line.find(": last ") != base::StringView::npos) {
      current_sensor_ = line.substr(0, line.find(": last ")).ToStdString();
    } else {
      in_recent_events_ = false;  // Next block ("Active sensors:", ...).
      current_sensor_.clear();
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

  // Parses a time-of-day "HH:MM:SS" or "HH:MM:SS.mmm" into wall-clock ms,
  // taking the date from the dumpstate start time. sensorservice is dumped
  // while dumpstate runs, so timestamps may land slightly *after* dumpstate
  // start; only times more than 1h ahead are treated as yesterday's
  // (e.g. a 23:50 event in a bugreport taken at 00:05).
  static std::optional<int64_t> ParseDayClockMs(base::StringView clock,
                                                int64_t ref_ms) {
    time_t ref_s = static_cast<time_t>(ref_ms / 1000);
    struct tm* ref_tm = gmtime(&ref_s);
    if (!ref_tm)
      return std::nullopt;
    base::StackString<40> iso("%04d-%02d-%02d %.*s", ref_tm->tm_year + 1900,
                              ref_tm->tm_mon + 1, ref_tm->tm_mday,
                              static_cast<int>(clock.size()), clock.data());
    std::optional<int64_t> ms = ParseIsoDateTimeMs(iso.string_view());
    if (ms && *ms > ref_ms + 3600 * 1000)
      *ms -= 86400000;
    return ms;
  }

  // Returns the first space-delimited token after `key`, skipping the
  // setw() space padding, e.g. FieldAfter("... pid= 3335 ...", "pid=").
  static std::string FieldAfter(base::StringView line, base::StringView key) {
    size_t pos = line.find(key);
    if (pos == base::StringView::npos)
      return std::string();
    pos += key.size();
    while (pos < line.size() && line.at(pos) == ' ')
      ++pos;
    size_t end = pos;
    while (end < line.size() && line.at(end) != ' ')
      ++end;
    return line.substr(pos, end - pos).ToStdString();
  }

  // `rec` is the tab-trimmed " 1 (ts=61.784559233, wall=09:02:11.325) 2.50,
  // 0.00, 0.00," line printed by RecentEventLogger::dump() (the data part is
  // "[value masked]" for privacy-sensitive sensors).
  void ParseRecentEvent(base::StringView rec) {
    if (current_sensor_.empty())
      return;
    size_t wall = rec.find("wall=");
    if (wall == base::StringView::npos)
      return;
    size_t close = rec.find(')', wall);
    if (close == base::StringView::npos)
      return;
    std::optional<int64_t> ts_ms =
        ParseDayClockMs(rec.substr(wall + 5, close - wall - 5),
                        *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Sensors";
    event.name = current_sensor_;
    size_t ts = rec.find("(ts=");
    if (ts != base::StringView::npos) {
      size_t comma = rec.find(',', ts);
      if (comma != base::StringView::npos && comma < close) {
        event.args.emplace_back(
            "elapsed_s", rec.substr(ts + 4, comma - ts - 4).ToStdString());
      }
    }
    base::StringView data = TrimLeft(rec.substr(close + 1));
    if (!data.empty())
      event.args.emplace_back("data", data.ToStdString());
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  // Matches SensorRegistrationInfo::dump() lines: "HH:MM:SS [+-] 0x...".
  static bool IsRegistrationLine(base::StringView line) {
    if (line.size() < 13 || line.at(2) != ':' || line.at(5) != ':' ||
        line.at(8) != ' ' || (line.at(9) != '+' && line.at(9) != '-') ||
        line.at(10) != ' ' || line.at(11) != '0' || line.at(12) != 'x') {
      return false;
    }
    for (size_t i : {0u, 1u, 3u, 4u, 6u, 7u}) {
      if (line.at(i) < '0' || line.at(i) > '9')
        return false;
    }
    return true;
  }

  void ParseRegistration(base::StringView line) {
    std::optional<int64_t> ts_ms =
        ParseDayClockMs(line.substr(0, 8), *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    // "(sensor, package): (Accel Sensor               , com.android...)".
    size_t names = line.find("(sensor, package): (");
    size_t close = line.rfind(')');
    if (names == base::StringView::npos || close == base::StringView::npos ||
        close <= names + 20)
      return;
    base::StringView inside = line.substr(names + 20, close - names - 20);
    size_t comma = inside.find(',');
    if (comma == base::StringView::npos)
      return;
    base::StringView sensor = inside.substr(0, comma);
    while (!sensor.empty() && sensor.at(sensor.size() - 1) == ' ')
      sensor = sensor.substr(0, sensor.size() - 1);  // setw(27) padding.
    base::StringView package = TrimLeft(inside.substr(comma + 1));
    if (sensor.empty())
      return;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Sensors";
    event.name = (line.at(9) == '+' ? "activate " : "deactivate ") +
                 sensor.ToStdString();
    event.args.emplace_back("package", package.ToStdString());
    event.args.emplace_back("handle", FieldAfter(line.substr(11), "0x"));
    event.args.emplace_back("pid", FieldAfter(line, "pid="));
    event.args.emplace_back("uid", FieldAfter(line, "uid="));
    event.args.emplace_back("sampling_period",
                            FieldAfter(line, "samplingPeriod="));
    event.args.emplace_back("batching_period",
                            FieldAfter(line, "batchingPeriod="));
    event.args.emplace_back("result", FieldAfter(line, "result="));
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  bool in_recent_events_ = false;
  std::string current_sensor_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysSensorServiceParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysSensorServiceParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
