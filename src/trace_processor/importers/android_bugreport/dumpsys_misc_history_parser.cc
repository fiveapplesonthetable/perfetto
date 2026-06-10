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
#include <cstring>
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
#include "src/trace_processor/importers/common/clock_tracker.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

constexpr size_t kMaxNameLen = 120;
// Timestamps further than this past dumpstate start are pending/future
// items (or parse artifacts) and are dropped.
constexpr int64_t kMaxFutureMs = 24 * 3600 * 1000;

// Shared parser for the small one-off history idioms of a handful of dumpsys
// services that the catch-all event-log parser misses (their lines either
// don't start with a digit or lack the LocalLog " - " separator). Configured
// per service via MiscHistoryConfig. Verbatim samples, SDK 36 (Baklava):
//
// time_detector ("SystemClockTime debug log:" block; the entries are UTC
// instants prefixed by an elapsed duration; the identical "Time change log:"
// block is deliberately not parsed to avoid duplicates):
//   SystemClockTime debug log:
//     PT58.925S / 2026-06-10T09:02:08.463938Z - TimeDetectorStrategyImpl: ...
//     PT1M1.078S / 2026-06-10T09:02:10.616552Z - Set system clock confidence...
//
// time_zone_detector ("Time zone debug log:" block, same shape):
//   Time zone debug log:
//     PT48.268S / 2026-06-10T09:01:57.806260Z - Time zone or confidence set...
//
// thread_network (ThreadNetworkCountryCode state lines with embedded UTC ISO
// timestamps):
//   mTelephonyCountryCodeInfo       : CountryCodeInfo{ mCountryCode: us,
//       mSource: Telephony, mUpdatedTimestamp: 2026-06-10T09:02:11.254312Z}
//
// uwb (UwbMetrics "initTime=" entries and UwbCountryCode local-wall ISO
// timestamps):
//   -- mUwbStateChangeInfoList --
//   initTime=06-10 09:02:11.371, mEnable=true, mSucceeded=true
//   mWifiCountryTimestamp: 2026-06-10 09:02:11.380
//   mCountryCodeUpdatedTimestamp: 2026-06-10 09:02:11.377
//
// usb (UsbDeviceLogger via DualDumpOutputStream: every line is keyed
// "USB Event Log="; the first value is the log title, subsequent values are
// "MM-dd HH:mm:ss:SSS <event>" entries - empty in the sampled bugreport):
//   USB Event Log=UsbDeviceManager activity
//
// Unrecognized lines are skipped silently; this parser never fails import.
struct MiscHistoryConfig {
  // Sub-header opening a "PT<elapsed> / <ISO-Z> - <msg>" debug-log block.
  const char* pt_log_trigger = nullptr;
  // Match "...[Tt]imestamp: <ISO>" state lines anywhere in the dump.
  bool timestamp_fields = false;
  // Match UwbMetrics "initTime=MM-DD HH:MM:SS.mmm, ..." lines.
  bool inittime_fields = false;
  // Keyed event-log line prefix, e.g. "USB Event Log=" (UsbDeviceLogger).
  const char* keyed_log_prefix = nullptr;
};

class DumpsysMiscHistoryParser : public BugreportSectionParser {
 public:
  DumpsysMiscHistoryParser(const BugreportParserDeps& deps,
                           const MiscHistoryConfig& cfg)
      : deps_(deps), cfg_(cfg), track_(deps.name + " events") {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (cfg_.pt_log_trigger) {
      if (t.StartsWith(cfg_.pt_log_trigger)) {
        in_pt_block_ = true;
        pt_category_ = std::string(cfg_.pt_log_trigger);
        if (!pt_category_.empty() && pt_category_.back() == ':')
          pt_category_.pop_back();
        return base::OkStatus();
      }
      if (in_pt_block_) {
        if (ParsePtLogLine(t))
          return base::OkStatus();
        if (!t.empty())
          in_pt_block_ = false;
      }
    }
    if (cfg_.keyed_log_prefix && t.StartsWith(cfg_.keyed_log_prefix)) {
      ParseKeyedLogLine(t.substr(strlen(cfg_.keyed_log_prefix)));
      return base::OkStatus();
    }
    if (cfg_.timestamp_fields)
      ParseTimestampFieldLine(t);
    if (cfg_.inittime_fields)
      ParseInitTimeLine(t);
    return base::OkStatus();
  }

 private:
  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  // Parses "YYYY-MM-DD HH:MM:SS[.ffffff][Z]" (also with a 'T' separator)
  // into wall ms; *is_utc is set if the token carries a trailing 'Z'.
  static std::optional<int64_t> ParseFlexIsoMs(base::StringView ts,
                                               bool* is_utc) {
    *is_utc = false;
    if (ts.size() < 19 || ts.at(4) != '-' || ts.at(7) != '-')
      return std::nullopt;
    size_t n = ts.size() < 32 ? ts.size() : 32;
    char buf[33];
    memcpy(buf, ts.data(), n);
    if (buf[10] == 'T')
      buf[10] = ' ';
    // End of the timestamp token: seconds plus optional fractional digits.
    size_t end = 19;
    if (end < n && buf[end] == '.') {
      ++end;
      while (end < n && buf[end] >= '0' && buf[end] <= '9')
        ++end;
    }
    *is_utc = end < n && buf[end] == 'Z';
    return ParseIsoDateTimeMs(base::StringView(buf, end));
  }

  // Parses a year-less "MM-DD" + "HH:MM:SS[.:]mmm" pair, deriving the year
  // from dumpstate start (same approach as the catch-all event-log parser).
  std::optional<int64_t> ParseMonthDayClockMs(base::StringView date,
                                              base::StringView clock) {
    if (!deps_.format->dumpstate_start_ms)
      return std::nullopt;
    if (date.size() != 5 || date.at(2) != '-' || clock.size() < 8)
      return std::nullopt;
    for (size_t i : {0u, 1u, 3u, 4u}) {
      if (date.at(i) < '0' || date.at(i) > '9')
        return std::nullopt;
    }
    int month = (date.at(0) - '0') * 10 + (date.at(1) - '0');
    int day = (date.at(3) - '0') * 10 + (date.at(4) - '0');
    if (month < 1 || month > 12 || day < 1 || day > 31)
      return std::nullopt;
    time_t ref_s =
        static_cast<time_t>(*deps_.format->dumpstate_start_ms / 1000);
    struct tm* ref_tm = gmtime(&ref_s);
    if (!ref_tm)
      return std::nullopt;
    int year = ref_tm->tm_year + 1900;
    if (month > ref_tm->tm_mon + 1)
      --year;  // December/January wraparound.
    // Normalize EventLogger-style "HH:MM:SS:mmm" -> "HH:MM:SS.mmm".
    char clock_buf[16];
    size_t clock_len = clock.size() < 15 ? clock.size() : 15;
    memcpy(clock_buf, clock.data(), clock_len);
    if (clock_len > 8 && clock_buf[8] == ':')
      clock_buf[8] = '.';
    base::StackString<40> iso("%04d-%.*s %.*s", year,
                              static_cast<int>(date.size()), date.data(),
                              static_cast<int>(clock_len), clock_buf);
    return ParseIsoDateTimeMs(iso.string_view());
  }

  // UTC timestamps (ISO with 'Z') are converted to device-local wall ms via
  // the timezone offset, when already known (see the notification parser for
  // the rationale; exact on UTC devices either way).
  int64_t AdjustUtc(int64_t ts_ms, bool is_utc) const {
    if (!is_utc)
      return ts_ms;
    return ts_ms + deps_.context->clock_tracker->timezone_offset().value_or(0) /
                       (1000 * 1000);
  }

  void Emit(int64_t ts_ms, base::StringView msg, const std::string& category) {
    if (ts_ms <= 0 || msg.empty())
      return;
    if (deps_.format->dumpstate_start_ms &&
        ts_ms > *deps_.format->dumpstate_start_ms + kMaxFutureMs) {
      return;
    }
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = track_;
    event.name = msg.substr(0, kMaxNameLen).ToStdString();
    if (!category.empty())
      event.args.emplace_back("category", category);
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg.ToStdString());
    deps_.emitter->Emit(ts_ms, std::move(event));
  }

  // "PT58.925S / 2026-06-10T09:02:08.463938Z - <msg>". Returns true if the
  // line had this shape (and was emitted).
  bool ParsePtLogLine(base::StringView t) {
    if (!t.StartsWith("PT"))
      return false;
    size_t slash = t.find(" / ");
    if (slash == base::StringView::npos)
      return false;
    base::StringView rest = t.substr(slash + 3);
    size_t dash = rest.find(" - ");
    if (dash == base::StringView::npos)
      return false;
    bool is_utc = false;
    std::optional<int64_t> ts_ms =
        ParseFlexIsoMs(rest.substr(0, dash), &is_utc);
    if (!ts_ms)
      return false;
    Emit(AdjustUtc(*ts_ms, is_utc), TrimLeft(rest.substr(dash + 3)),
         pt_category_);
    return true;
  }

  // UsbDeviceLogger value: either the log title ("UsbDeviceManager activity")
  // or an "MM-dd HH:mm:ss:SSS <event>" entry.
  void ParseKeyedLogLine(base::StringView value) {
    if (value.size() >= 18 && value.at(0) >= '0' && value.at(0) <= '9' &&
        value.at(5) == ' ') {
      std::optional<int64_t> ts_ms =
          ParseMonthDayClockMs(value.substr(0, 5), value.substr(6, 12));
      if (ts_ms) {
        Emit(*ts_ms, TrimLeft(value.substr(18)), keyed_category_);
        return;
      }
    }
    keyed_category_ = value.ToStdString();  // Title line.
  }

  // State lines with an embedded "[Tt]imestamp: <ISO>" value; the whole line
  // is the event name (e.g. "mWifiCountryTimestamp: 2026-06-10 09:02:11.380",
  // "... mUpdatedTimestamp: 2026-06-10T09:02:11.254312Z}").
  void ParseTimestampFieldLine(base::StringView t) {
    size_t pos = t.find("imestamp: ");
    if (pos == base::StringView::npos)
      return;
    bool is_utc = false;
    std::optional<int64_t> ts_ms = ParseFlexIsoMs(t.substr(pos + 10), &is_utc);
    if (!ts_ms)
      return;
    Emit(AdjustUtc(*ts_ms, is_utc), t, "state timestamp");
  }

  // "initTime=06-10 09:02:11.371, mEnable=true, mSucceeded=true".
  void ParseInitTimeLine(base::StringView t) {
    if (!t.StartsWith("initTime="))
      return;
    base::StringView value = t.substr(strlen("initTime="));
    size_t comma = value.find(',');
    if (comma == base::StringView::npos || comma < 14 || value.size() < 7 ||
        value.at(5) != ' ') {
      return;
    }
    std::optional<int64_t> ts_ms =
        ParseMonthDayClockMs(value.substr(0, 5), value.substr(6, comma - 6));
    if (!ts_ms)
      return;
    Emit(*ts_ms, t, "UwbMetrics");
  }

  const BugreportParserDeps deps_;
  const MiscHistoryConfig cfg_;
  const std::string track_;
  bool in_pt_block_ = false;
  std::string pt_category_;
  std::string keyed_category_;
};

std::unique_ptr<BugreportSectionParser> Make(const BugreportParserDeps& deps,
                                             const MiscHistoryConfig& cfg) {
  return std::make_unique<DumpsysMiscHistoryParser>(deps, cfg);
}

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysTimeDetectorParser(
    const BugreportParserDeps& deps) {
  MiscHistoryConfig cfg;
  cfg.pt_log_trigger = "SystemClockTime debug log:";
  return Make(deps, cfg);
}

std::unique_ptr<BugreportSectionParser> CreateDumpsysTimeZoneDetectorParser(
    const BugreportParserDeps& deps) {
  MiscHistoryConfig cfg;
  cfg.pt_log_trigger = "Time zone debug log:";
  return Make(deps, cfg);
}

std::unique_ptr<BugreportSectionParser> CreateDumpsysThreadNetworkParser(
    const BugreportParserDeps& deps) {
  MiscHistoryConfig cfg;
  cfg.timestamp_fields = true;
  return Make(deps, cfg);
}

std::unique_ptr<BugreportSectionParser> CreateDumpsysUwbParser(
    const BugreportParserDeps& deps) {
  MiscHistoryConfig cfg;
  cfg.timestamp_fields = true;
  cfg.inittime_fields = true;
  return Make(deps, cfg);
}

std::unique_ptr<BugreportSectionParser> CreateDumpsysUsbParser(
    const BugreportParserDeps& deps) {
  MiscHistoryConfig cfg;
  cfg.keyed_log_prefix = "USB Event Log=";
  return Make(deps, cfg);
}

// "DUMP OF SERVICE phone:": every timestamped sub-log (mDataRoamingNotifLog,
// ImsResolver "Connection Repository Log:" / "Event Log:",
// ImsStateCallbackController "Most recent logs:", DomainSelectionResolver
// "Event Log:" and the OmtpVvm "======== Logs =========" block) prints
// LocalLog "2026-06-10T09:02:14.996571 - <msg>" lines, which the catch-all
// event-log parser already imports; nothing is left to parse here.
std::unique_ptr<BugreportSectionParser> CreateDumpsysPhoneExtrasParser(
    const BugreportParserDeps&) {
  return nullptr;
}

}  // namespace perfetto::trace_processor::android_bugreport
