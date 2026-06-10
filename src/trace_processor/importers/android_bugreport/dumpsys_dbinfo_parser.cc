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

// SQL statements longer than this are truncated in the "sql" arg.
constexpr size_t kMaxSqlLen = 120;

// Parses "DUMP OF SERVICE dbinfo:": per-process SQLite connection pool dumps
// with "Most recently executed operations" rings. As of SDK 36 (Baklava):
//
//   ** Database info for pid 3603 [com.android.settings] **
//   Connection pool for /data/user_de/0/com.android.settings/databases/
//       battery-usage-db-v11:
//     ...
//         Most recently executed operations:
//           0: [06-10 09:21:34.320] executeForLong took 0ms - succeeded,
//               sql="PRAGMA temp.page_size;", path=/data/user_de/0/...
//           9: [06-10 09:02:10.658] TRANSACTION-IMMEDIATE took 4ms -
//               succeeded, path=..., result=1
//
// (operation entries are single lines, wrapped here for readability). Each
// completed operation becomes a slice on the "Database ops" track, named
// "<operation> <db basename>", with the "took Xms" value as the duration.
// Placeholder entries ("[01-01 00:00:00.000] null started ...ms ago -
// running") have no "took" and are skipped. Timestamps are year-less; the
// year is derived from the dumpstate start time. The catch-all event-log
// parser ignores all of these lines (no LocalLog-sized " - " prefix).
// Unrecognized lines are skipped silently; this parser never fails import.
class DumpsysDbinfoParser : public BugreportSectionParser {
 public:
  explicit DumpsysDbinfoParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.size() < 22)
      return base::OkStatus();
    char c = t.at(0);
    if (c >= '0' && c <= '9') {
      ParseOperation(t);
    } else if (c == '*' && t.StartsWith("** Database info for pid ")) {
      ParseProcessHeader(t.substr(25));
    } else if (c == 'C' && t.StartsWith("Connection pool for ")) {
      ParsePoolHeader(t.substr(20));
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

  // Parses "MM-DD" + "HH:MM:SS.mmm" into wall-clock ms, deriving the year
  // from the dumpstate start time (picking the year that puts the event at
  // or before dumpstate start, for December/January wraparound).
  static std::optional<int64_t> MonthDayClockToWallMs(base::StringView date,
                                                      base::StringView clock,
                                                      int64_t ref_ms) {
    int month = (date.at(0) - '0') * 10 + (date.at(1) - '0');
    if (month < 1 || month > 12)
      return std::nullopt;
    time_t ref_s = static_cast<time_t>(ref_ms / 1000);
    struct tm* ref_tm = gmtime(&ref_s);
    if (!ref_tm)
      return std::nullopt;
    int year = ref_tm->tm_year + 1900;
    if (month > ref_tm->tm_mon + 1)
      --year;
    base::StackString<40> iso("%04d-%.*s %.*s", year,
                              static_cast<int>(date.size()), date.data(),
                              static_cast<int>(clock.size()), clock.data());
    return ParseIsoDateTimeMs(iso.string_view());
  }

  // "3603 [com.android.settings] **" (the part after "for pid ").
  void ParseProcessHeader(base::StringView rest) {
    pid_.clear();
    process_.clear();
    db_name_.clear();
    size_t sp = rest.find(' ');
    if (sp == base::StringView::npos)
      return;
    pid_ = rest.substr(0, sp).ToStdString();
    size_t open = rest.find('[');
    size_t close = rest.rfind(']');
    if (open != base::StringView::npos && close != base::StringView::npos &&
        close > open) {
      process_ = rest.substr(open + 1, close - open - 1).ToStdString();
    }
  }

  // "/data/user/0/.../databases/contacts2.db:" (the part after "pool for ").
  void ParsePoolHeader(base::StringView path) {
    if (!path.empty() && path.at(path.size() - 1) == ':')
      path = path.substr(0, path.size() - 1);
    size_t slash = path.rfind('/');
    base::StringView name =
        slash == base::StringView::npos ? path : path.substr(slash + 1);
    db_name_ = name.ToStdString();
  }

  // "0: [06-10 09:21:34.320] executeForLong took 0ms - succeeded, sql=...".
  void ParseOperation(base::StringView t) {
    if (!deps_.format->dumpstate_start_ms)
      return;
    size_t open = t.find(": [");
    // The ring index is at most 2 digits ("0:".."19:").
    if (open == base::StringView::npos || open > 3)
      return;
    size_t ts_pos = open + 3;
    // "[MM-DD HH:MM:SS.mmm]" is 18 chars of timestamp plus the brackets.
    if (t.size() < ts_pos + 20 || t.at(ts_pos + 18) != ']' ||
        t.at(ts_pos + 2) != '-' || t.at(ts_pos + 5) != ' ' ||
        t.at(ts_pos + 14) != '.') {
      return;
    }
    base::StringView rest = TrimLeft(t.substr(ts_pos + 19));
    size_t sp = rest.find(' ');
    if (sp == base::StringView::npos)
      return;
    base::StringView op = rest.substr(0, sp);
    base::StringView after_op = rest.substr(sp);
    // Completed operations print " took Xms"; in-flight placeholders print
    // " started Xms ago" and are skipped.
    if (!after_op.StartsWith(" took "))
      return;
    base::StringView dur_sv = after_op.substr(6);
    size_t ms_pos = dur_sv.find("ms");
    if (ms_pos == base::StringView::npos)
      return;
    std::optional<int64_t> dur_ms =
        base::StringToInt64(dur_sv.substr(0, ms_pos).ToStdString());
    if (!dur_ms || *dur_ms < 0)
      return;
    std::optional<int64_t> ts_ms =
        MonthDayClockToWallMs(t.substr(ts_pos, 5), t.substr(ts_pos + 6, 12),
                              *deps_.format->dumpstate_start_ms);
    if (!ts_ms)
      return;

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kSlice;
    event.dur_ns = *dur_ms * 1000 * 1000;
    event.track = "Database ops";
    event.name = op.ToStdString();
    if (!db_name_.empty())
      event.name += " " + db_name_;
    if (!process_.empty())
      event.args.emplace_back("process", process_);
    if (!pid_.empty())
      event.args.emplace_back("pid", pid_);
    // " - succeeded, sql="...", path=...".
    size_t status_pos = after_op.find(" - ");
    if (status_pos != base::StringView::npos) {
      base::StringView status = after_op.substr(status_pos + 3);
      size_t comma = status.find(',');
      if (comma != base::StringView::npos)
        status = status.substr(0, comma);
      if (!status.empty())
        event.args.emplace_back("status", status.ToStdString());
    }
    size_t sql_pos = after_op.find(" sql=\"");
    if (sql_pos != base::StringView::npos) {
      base::StringView sql = after_op.substr(sql_pos + 6);
      size_t quote = sql.find('"');
      if (quote != base::StringView::npos)
        sql = sql.substr(0, quote);
      if (!sql.empty())
        event.args.emplace_back("sql", sql.substr(0, kMaxSqlLen).ToStdString());
    }
    deps_.emitter->Emit(*ts_ms, std::move(event));
  }

  const BugreportParserDeps deps_;
  std::string pid_;
  std::string process_;
  std::string db_name_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysDbinfoParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysDbinfoParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
