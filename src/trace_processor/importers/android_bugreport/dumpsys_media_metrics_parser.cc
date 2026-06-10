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

// Args longer than this are truncated.
constexpr size_t kMaxArgLen = 120;

// Parses the media metrics item dump of "DUMP OF SERVICE media.metrics:".
// The mediametrics service keeps a ring buffer of submitted items and dumps
// each as one "<index>: {<key>, (<time>), (<pkg>, <pid>, <uid>), (<props>)}"
// line (MediaMetricsService::dumpQueue). Verbatim samples, SDK 36 (Baklava),
// single lines wrapped here for readability:
//
//     0: {audio.flinger, (06-10 09:01:59.620), (audioserver, 0, 1041),
//        (event#=ctor)}
//    76: {extractor, (06-10 09:02:09.410), (android.uid.system, 0, 1000),
//        (android.media.mediaextractor.entry=ndk-with-jvm, ...)}
//   193: {mediadrm.errored, (06-10 09:02:15.504), (com.android.rkpdapp, 0,
//        10110), (api=initCheck, cdm_err=0, ...)}
//
// The "MM-DD HH:MM:SS.mmm" timestamp has no year; it is derived from the
// dumpstate start time. Property values may themselves contain parentheses
// (e.g. "forceUseDueTo=updateStreamMuteFromRingerMode() from u/pid:...") so
// the parenthesized groups are matched depth-aware.
//
// Each item becomes an instant on the "Media metrics" track named
// "<key> <event>" (the "event#=" property, when present; codec/extractor
// items have none), with package/pid/uid and the property list as args.
//
// Division of labor: the section also contains bare timestamped lines such
// as "06-10 09:01:59.625 AudioFlinger ctor" (the audio analytics summary
// log). Those are deliberately NOT parsed here: the generic catch-all
// dumpsys event-log parser handles bare-timestamp lines for every service,
// including this one. This parser handles only the "N: {...}" item shape.
//
// Unrecognized lines are skipped silently; this parser never fails import.
class DumpsysMediaMetricsParser : public BugreportSectionParser {
 public:
  explicit DumpsysMediaMetricsParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    // Item lines are "<index>: {...}".
    size_t i = 0;
    while (i < t.size() && IsDigit(t.at(i)))
      ++i;
    if (i > 0 && t.substr(i).StartsWith(": {") && t.at(t.size() - 1) == '}' &&
        deps_.format->dumpstate_start_ms) {
      ParseItem(t.substr(i + 3, t.size() - i - 4));  // Inside the braces.
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

  static bool IsDigit(char c) { return c >= '0' && c <= '9'; }

  // If `sv` starts with '(' returns the content of the parenthesized group,
  // matching nested parens, and advances `sv` past it (and past a ", " that
  // may follow). Returns nullopt on unbalanced parens.
  static std::optional<base::StringView> TakeParenGroup(base::StringView* sv) {
    if (sv->empty() || sv->at(0) != '(')
      return std::nullopt;
    int depth = 0;
    for (size_t i = 0; i < sv->size(); ++i) {
      char c = sv->at(i);
      if (c == '(') {
        ++depth;
      } else if (c == ')' && --depth == 0) {
        base::StringView group = sv->substr(1, i - 1);
        *sv = TrimLeft(sv->substr(i + 1));
        if (sv->StartsWith(","))
          *sv = TrimLeft(sv->substr(1));
        return group;
      }
    }
    return std::nullopt;
  }

  // Parses a year-less timestamp split into `date` ("06-10") and `clock`
  // ("09:01:59.620") into wall-clock ms. The year is derived from the
  // dumpstate start time, picking the year that puts the event at or before
  // dumpstate start.
  static std::optional<int64_t> ParseMonthDayTimeMs(
      base::StringView date,
      base::StringView clock,
      int64_t dumpstate_start_ms) {
    if (date.size() != 5 || date.at(2) != '-')
      return std::nullopt;
    for (size_t i : {0u, 1u, 3u, 4u}) {
      if (!IsDigit(date.at(i)))
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

  // `body` is "<key>, (<time>), (<pkg>, <pid>, <uid>), (<props>)".
  void ParseItem(base::StringView body) {
    size_t comma = body.find(',');
    if (comma == base::StringView::npos)
      return;
    base::StringView key = body.substr(0, comma);
    base::StringView rest = TrimLeft(body.substr(comma + 1));
    std::optional<base::StringView> time_group = TakeParenGroup(&rest);
    std::optional<base::StringView> src_group = TakeParenGroup(&rest);
    std::optional<base::StringView> props = TakeParenGroup(&rest);
    if (key.empty() || !time_group || !src_group || !props)
      return;

    size_t sp = time_group->find(' ');
    if (sp == base::StringView::npos)
      return;
    std::optional<int64_t> ts_ms = ParseMonthDayTimeMs(
        time_group->substr(0, sp), time_group->substr(sp + 1),
        *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;

    // "<pkg>, <pid>, <uid>": split at the last two commas (the package name
    // is free-form).
    size_t uid_comma = src_group->rfind(',');
    size_t pid_comma = uid_comma == base::StringView::npos
                           ? base::StringView::npos
                           : src_group->substr(0, uid_comma).rfind(',');
    if (pid_comma == base::StringView::npos)
      return;

    // The "event#=<value>" property, when present, qualifies the item name.
    base::StringView event;
    size_t ev = props->StartsWith("event#=") ? 0 : props->find(", event#=");
    if (ev != base::StringView::npos) {
      event = props->substr(ev + (ev == 0 ? 7 : 9));
      size_t end = event.find(',');
      if (end != base::StringView::npos)
        event = event.substr(0, end);
    }

    BugreportTimelineEvent event_out;
    event_out.kind = BugreportTimelineEvent::Kind::kInstant;
    event_out.track = "Media metrics";
    event_out.name = key.ToStdString();
    if (!event.empty())
      event_out.name += " " + event.ToStdString();
    const std::pair<const char*, base::StringView> item_args[] = {
        {"package", src_group->substr(0, pid_comma)},
        {"pid",
         TrimLeft(src_group->substr(pid_comma + 1, uid_comma - pid_comma - 1))},
        {"uid", TrimLeft(src_group->substr(uid_comma + 1))},
        {"props", props->substr(0, kMaxArgLen)}};
    for (const auto& [arg_key, val] : item_args) {
      if (!val.empty())
        event_out.args.emplace_back(arg_key, val.ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event_out));
  }

  const BugreportParserDeps deps_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysMediaMetricsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysMediaMetricsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
