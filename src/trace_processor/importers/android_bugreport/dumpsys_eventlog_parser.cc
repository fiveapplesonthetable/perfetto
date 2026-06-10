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

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Names longer than this are truncated; full text goes in the "message" arg.
constexpr size_t kMaxNameLen = 120;

// Generic parser for the two time-stamped event-log formats that many dumpsys
// services share. One instance is registered per service (see the per-service
// factories at the bottom); each emits instants on "<service> events".
//
// 1. com.android.internal.util.StateMachine.dump() record logs, e.g. (from
//    "DUMP OF SERVICE isms:", SDK 36 Baklava; one line, wrapped here):
//      CdmaInboundSmsHandler:
//       total records=2
//        rec[0]: time=06-10 09:02:10.558 processed=StartupState
//            org=StartupState dest=IdleState what=EVENT_START_ACCEPTING_SMS
//    The state machine name is recovered heuristically: it is the most
//    recent less-indented line preceding each "total records=" header.
//
// 2. android.util.LocalLog::dump() lines, "<timestamp> - <message>". Modern
//    LocalLog (SDK >= 31) prints LocalDateTime.now(): ISO with a 'T'
//    separator and microsecond precision; NetworkPolicyLogger puts ':'
//    before the millis; legacy LocalLog used "MM-dd HH:mm:ss.SSS".
//    Verbatim samples (SDK 36 Baklava bugreport):
//      connectivity:       2026-06-10T09:02:44.029112 - REGISTER uid/pid:...
//      telephony.registry: 2026-06-10T09:02:10.698952 - notifyActiveData...
//      netpolicy:          2026-06-10T09:03:02:681 - Firewall rule changed...
//      legacy format:      06-10 09:02:09.144 - <message>
//
// Unrecognized lines are skipped silently; this parser never fails import.
class DumpsysEventLogParser : public BugreportSectionParser {
 public:
  DumpsysEventLogParser(const BugreportParserDeps& deps,
                        const char* service_label,
                        bool app_service_mode = false)
      : deps_(deps),
        track_(std::string(service_label) + " events"),
        app_service_mode_(app_service_mode) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView trimmed = TrimLeft(line);
    size_t indent = line.size() - trimmed.size();
    // In APP SERVICES / APP PROVIDERS dumpstate sections, per-app dumps are
    // introduced by "SERVICE com.foo/.BarService <hex> pid=N user=0" lines;
    // events are attributed to a track named after the component.
    if (app_service_mode_ && trimmed.StartsWith("SERVICE ") &&
        trimmed.find(" pid=") != base::StringView::npos) {
      base::StringView comp = trimmed.substr(strlen("SERVICE "));
      comp = comp.substr(0, comp.find(' '));
      size_t slash = comp.rfind('/');
      base::StringView cls =
          slash == base::StringView::npos ? comp : comp.substr(slash + 1);
      size_t dot = cls.rfind('.');
      if (dot != base::StringView::npos) {
        cls = cls.substr(dot + 1);
      }
      track_ = cls.ToStdString() + " events";
      return base::OkStatus();
    }
    if (trimmed.StartsWith("rec[")) {
      ParseRecord(trimmed);
      return base::OkStatus();
    }
    if (trimmed.StartsWith("total records=")) {
      state_machine_ = (!last_line_.empty() && last_indent_ < indent)
                           ? last_line_
                           : std::string();
      return base::OkStatus();
    }
    // Third idiom: com.android.server.utils.EventLogger dumps, a
    // "Events log: <tag>" header followed by "MM-DD HH:MM:SS:mmm <event>"
    // entries (colon before the millis).
    if (trimmed.StartsWith("Events log: ")) {
      event_logger_category_ =
          trimmed.substr(strlen("Events log: ")).ToStdString();
      return base::OkStatus();
    }
    if (!event_logger_category_.empty()) {
      if (ParseEventLoggerLine(trimmed))
        return base::OkStatus();
      if (!trimmed.empty())
        event_logger_category_.clear();
    }
    if (ParseLocalLogLine(trimmed))
      return base::OkStatus();
    if (ParseBareTimestampLine(trimmed))
      return base::OkStatus();
    if (!trimmed.empty()) {
      last_line_ = trimmed.ToStdString();
      if (!last_line_.empty() && last_line_.back() == ':')
        last_line_.pop_back();
      last_indent_ = indent;
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

  // Parses a year-less timestamp split into `date` ("06-10") and `clock`
  // ("09:02:10.650") into wall-clock ms. The year is derived from the
  // dumpstate start time, picking the year that puts the event at or before
  // dumpstate start.
  static std::optional<int64_t> ParseMonthDayTimeMs(
      base::StringView date,
      base::StringView clock,
      int64_t dumpstate_start_ms) {
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

  // Parses a LocalLog timestamp: ISO "2026-06-10T09:02:44.029112" (also with
  // a space separator or NetworkPolicyLogger's ':' before the millis), or
  // legacy "06-10 09:02:09.144" (year derived from dumpstate start).
  std::optional<int64_t> ParseLocalLogTimeMs(base::StringView ts) {
    if (ts.size() < 14 || ts.size() > 32)
      return std::nullopt;
    if (ts.size() >= 19 && ts.at(4) == '-' && ts.at(7) == '-') {
      // ISO date: normalize 'T' -> ' ' and "HH:MM:SS:mmm" -> "HH:MM:SS.mmm".
      char buf[33];
      memcpy(buf, ts.data(), ts.size());
      if (buf[10] == 'T')
        buf[10] = ' ';
      if (ts.size() > 19 && buf[19] == ':')
        buf[19] = '.';
      return ParseIsoDateTimeMs(base::StringView(buf, ts.size()));
    }
    // Legacy "MM-DD HH:MM:SS.mmm".
    if (!deps_.format->dumpstate_start_ms || ts.size() < 7 || ts.at(5) != ' ')
      return std::nullopt;
    return ParseMonthDayTimeMs(ts.substr(0, 5), ts.substr(6),
                               *deps_.format->dumpstate_start_ms);
  }

  // Fourth idiom: lines that simply begin with a millisecond-resolution
  // timestamp followed by event text, with no " - " separator:
  //   "06-10 09:01:53.297 netd starting"                       (netd)
  //   "2026-06-10 09:02:03.835 COMMIT_UID_STATE uid=1000 ..."  (appops)
  // The fractional part is required: it distinguishes these event-log lines
  // from second-resolution state stamps (e.g. dropbox entries or settings
  // mutations, which bespoke parsers own). Returns true if emitted.
  bool ParseBareTimestampLine(base::StringView trimmed) {
    if (trimmed.size() < 20 || trimmed.at(0) < '0' || trimmed.at(0) > '9')
      return false;
    std::optional<int64_t> ts_ms;
    size_t msg_start = 0;
    if (trimmed.at(4) == '-' && trimmed.at(7) == '-' && trimmed.size() >= 24 &&
        trimmed.at(10) == ' ' && trimmed.at(19) == '.') {
      // "YYYY-MM-DD HH:MM:SS.mmm ".
      ts_ms = ParseIsoDateTimeMs(trimmed.substr(0, 23));
      msg_start = 23;
    } else if (trimmed.at(2) == '-' && trimmed.at(5) == ' ' &&
               trimmed.size() >= 19 && trimmed.at(8) == ':' &&
               trimmed.at(11) == ':' && trimmed.at(14) == '.' &&
               deps_.format->dumpstate_start_ms) {
      // "MM-DD HH:MM:SS.mmm ".
      ts_ms = ParseMonthDayTimeMs(trimmed.substr(0, 5), trimmed.substr(6, 12),
                                  *deps_.format->dumpstate_start_ms);
      msg_start = 18;
    }
    // The separator is a space, or a tab in e.g. the bluetooth enable log.
    if (!ts_ms || msg_start >= trimmed.size() ||
        (trimmed.at(msg_start) != ' ' && trimmed.at(msg_start) != '\t')) {
      return false;
    }
    std::string msg;
    for (char c : trimmed.substr(msg_start).ToStdString()) {
      msg += (c == '\t') ? ' ' : c;
    }
    msg = base::TrimWhitespace(msg);
    if (msg.empty())
      return false;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = track_;
    event.name = msg.substr(0, kMaxNameLen);
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg);
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return true;
  }

  // Handles EventLogger entries: "06-10 09:02:08:481 <event text>" (the
  // millis separator is a colon). Returns true if emitted.
  bool ParseEventLoggerLine(base::StringView trimmed) {
    if (trimmed.size() < 19 || trimmed.at(0) < '0' || trimmed.at(0) > '9' ||
        trimmed.at(5) != ' ') {
      return false;
    }
    if (!deps_.format->dumpstate_start_ms)
      return false;
    base::StringView clock = trimmed.substr(6, 12);
    if (clock.at(8) != ':')
      return false;
    // Normalize "HH:MM:SS:mmm" -> "HH:MM:SS.mmm".
    char clock_buf[13];
    memcpy(clock_buf, clock.data(), 12);
    clock_buf[8] = '.';
    std::optional<int64_t> ts_ms = ParseMonthDayTimeMs(
        trimmed.substr(0, 5), base::StringView(clock_buf, 12),
        *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return false;
    base::StringView msg = TrimLeft(trimmed.substr(18));
    if (msg.empty())
      return false;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = track_;
    event.name = msg.substr(0, kMaxNameLen).ToStdString();
    event.args.emplace_back("category", event_logger_category_);
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg.ToStdString());
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return true;
  }

  // Handles "<timestamp> - <message>" lines. Returns true if emitted.
  bool ParseLocalLogLine(base::StringView trimmed) {
    if (trimmed.empty() || trimmed.at(0) < '0' || trimmed.at(0) > '9')
      return false;
    size_t sep = trimmed.find(" - ");
    if (sep == base::StringView::npos)
      return false;
    std::optional<int64_t> ts_ms = ParseLocalLogTimeMs(trimmed.substr(0, sep));
    if (!ts_ms)
      return false;
    base::StringView msg = TrimLeft(trimmed.substr(sep + 3));
    if (msg.empty())
      return false;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = track_;
    event.name = msg.substr(0, kMaxNameLen).ToStdString();
    if (msg.size() > kMaxNameLen)
      event.args.emplace_back("message", msg.ToStdString());
    deps_.emitter->Emit(*ts_ms, std::move(event));
    return true;
  }

  // `rec` is the left-trimmed "rec[N]: time=MM-DD HH:MM:SS.mmm processed=X
  // org=Y dest=Z what=MSG <extra>" line.
  void ParseRecord(base::StringView rec) {
    if (!deps_.format->dumpstate_start_ms)
      return;
    size_t time_pos = rec.find("time=");
    size_t what_pos = rec.find(" what=");
    if (time_pos == base::StringView::npos ||
        what_pos == base::StringView::npos || what_pos < time_pos)
      return;

    // The time= value spans two space-separated tokens: date + clock.
    base::StringView rest = rec.substr(time_pos + 5);
    size_t sp = rest.find(' ');
    if (sp == base::StringView::npos)
      return;
    base::StringView date = rest.substr(0, sp);
    base::StringView clock = rest.substr(sp + 1);
    sp = clock.find(' ');
    if (sp != base::StringView::npos)
      clock = clock.substr(0, sp);
    std::optional<int64_t> ts_ms =
        ParseMonthDayTimeMs(date, clock, *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;

    // Single-token fields before what=; what= is followed by free-form extra.
    base::StringView head = rec.substr(0, what_pos);
    auto field = [head](base::StringView key) {
      size_t pos = head.find(key);
      if (pos == base::StringView::npos)
        return base::StringView();
      base::StringView v = head.substr(pos + key.size());
      size_t end = v.find(' ');
      return end == base::StringView::npos ? v : v.substr(0, end);
    };
    base::StringView processed = field(" processed=");
    base::StringView org = field(" org=");
    base::StringView dest = field(" dest=");
    base::StringView what = rec.substr(what_pos + 6);
    base::StringView extra;
    sp = what.find(' ');
    if (sp != base::StringView::npos) {
      extra = TrimLeft(what.substr(sp + 1));
      what = what.substr(0, sp);
    }
    if (what.empty())
      return;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = track_;
    event.name = what.ToStdString();
    if (!state_machine_.empty())
      event.args.emplace_back("state_machine", state_machine_);
    const std::pair<const char*, base::StringView> rec_args[] = {
        {"processed", processed},
        {"org", org},
        {"dest", dest},
        {"extra", extra}};
    for (const auto& [key, val] : rec_args) {
      if (!val.empty())
        event.args.emplace_back(key, val.ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  std::string track_;
  const bool app_service_mode_;
  // Candidate state machine name: the last non-rec line seen, used as block
  // name when a "total records=" header follows at deeper indentation.
  std::string last_line_;
  size_t last_indent_ = 0;
  std::string state_machine_;
  std::string event_logger_category_;
};

}  // namespace

// Registered as a catch-all ("*") for every dumpsys service: any service
// that logs history through the standard Android idioms (StateMachine
// records, LocalLog) automatically contributes timeline events on a track
// named after the service.
// For the "APP SERVICES *" / "APP PROVIDERS *" dumpstate sections, which
// contain per-app service dumps full of LocalLog history (e.g. telephony's
// PhoneSwitcher), attributed per-component via "SERVICE <comp> ..." headers.
std::unique_ptr<BugreportSectionParser> CreateAppServicesEventLogParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysEventLogParser>(deps, "App services",
                                                 /*app_service_mode=*/true);
}

std::unique_ptr<BugreportSectionParser> CreateDumpsysEventLogParser(
    const BugreportParserDeps& deps) {
  // Services whose timestamped lines are already fully covered elsewhere
  // decline the catch-all to avoid duplicates: power (wake lock log ->
  // bespoke slices), audio (EventLogger -> bespoke), batterystats (the text
  // battery history duplicates the CHECKIN BATTERYSTATS data) and alarm
  // (bare-ISO TIME_TICK history -> bespoke).
  if (deps.name == "power" || deps.name == "audio" ||
      deps.name == "batterystats" || deps.name == "alarm") {
    return nullptr;
  }
  return std::make_unique<DumpsysEventLogParser>(deps, deps.name.c_str());
}

}  // namespace perfetto::trace_processor::android_bugreport
