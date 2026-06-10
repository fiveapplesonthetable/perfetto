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

// Parses "DUMP OF SERVICE connmetrics:" (IpConnectivityMetrics). As of
// SDK 36 (Baklava) two line shapes carry time-of-day timestamps (no date):
//
// 1. "metrics events:" entries:
//      ConnectivityMetricsEvent(09:02:15.295, netId=100, transports={0}):
//          NetworkEvent(NETWORK_CONNECTED, 0ms)
//      ConnectivityMetricsEvent(09:02:15.325, netId=100, transports={0}):
//          ValidationProbeEvent(PROBE_DNS:1 FIRST_VALIDATION, 19ms)
//    (one line each, wrapped here for readability).
//
// 2. "network statistics:" / "default network events:" entries:
//      09:00:00.000: {netId=100, transports={}, dns avg=6ms max=7ms ...}
//      09:02:04.524: DefaultNetworkEvent(netId=0, transports={}, ip=NONE,...)
//
// Both become instants on the "Network metrics" track. The date is derived
// from the dumpstate start time (same approach as the sensorservice parser):
// times more than 1h after dumpstate start are treated as yesterday's.
// Unrecognized lines are skipped silently; this parser never fails import.
class DumpsysConnMetricsParser : public BugreportSectionParser {
 public:
  explicit DumpsysConnMetricsParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (!deps_.format->dumpstate_start_ms)
      return base::OkStatus();  // No reference time: cannot derive dates.
    if (line.StartsWith("ConnectivityMetricsEvent(")) {
      ParseMetricsEvent(line);
    } else if (IsClockPrefixedLine(line)) {
      ParseClockPrefixedLine(line);
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

  // Returns whether `clock` looks like "HH:MM:SS.mmm".
  static bool IsClock(base::StringView clock) {
    if (clock.size() != 12 || clock.at(2) != ':' || clock.at(5) != ':' ||
        clock.at(8) != '.') {
      return false;
    }
    for (size_t i : {0u, 1u, 3u, 4u, 6u, 7u, 9u, 10u, 11u}) {
      if (clock.at(i) < '0' || clock.at(i) > '9')
        return false;
    }
    return true;
  }

  // Parses a time-of-day "HH:MM:SS.mmm" into wall-clock ms, taking the date
  // from the dumpstate start time. connmetrics is dumped while dumpstate
  // runs, so timestamps may land slightly *after* dumpstate start; only
  // times more than 1h ahead are treated as yesterday's (e.g. a 23:50 event
  // in a bugreport taken at 00:05).
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

  void EmitInstant(int64_t ts_ms,
                   base::StringView msg,
                   base::StringView net_meta) {
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Network metrics";
    event.name = msg.substr(0, kMaxNameLen).ToStdString();
    if (!net_meta.empty())
      event.args.emplace_back("network", net_meta.ToStdString());
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg.ToStdString());
    deps_.emitter->Emit(ts_ms, std::move(event));
  }

  // "ConnectivityMetricsEvent(<clock>, <net meta>): <event>".
  void ParseMetricsEvent(base::StringView line) {
    base::StringView inside = line.substr(25);  // After the '('.
    size_t close = inside.find("): ");
    if (close == base::StringView::npos)
      return;
    base::StringView meta = inside.substr(0, close);
    base::StringView msg = TrimLeft(inside.substr(close + 3));
    size_t comma = meta.find(',');
    if (comma == base::StringView::npos || msg.empty())
      return;
    base::StringView clock = meta.substr(0, comma);
    if (!IsClock(clock))
      return;
    std::optional<int64_t> ts_ms =
        ParseDayClockMs(clock, *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    EmitInstant(*ts_ms, msg, TrimLeft(meta.substr(comma + 1)));
  }

  // "HH:MM:SS.mmm: <details>" (network statistics / default network events).
  static bool IsClockPrefixedLine(base::StringView line) {
    return line.size() > 14 && line.at(12) == ':' && line.at(13) == ' ' &&
           IsClock(line.substr(0, 12));
  }

  void ParseClockPrefixedLine(base::StringView line) {
    std::optional<int64_t> ts_ms =
        ParseDayClockMs(line.substr(0, 12), *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;
    base::StringView msg = TrimLeft(line.substr(14));
    if (msg.empty())
      return;
    EmitInstant(*ts_ms, msg, base::StringView());
  }

  const BugreportParserDeps deps_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysConnMetricsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysConnMetricsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
