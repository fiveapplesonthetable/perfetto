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
#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the "Job history:" block of "DUMP OF SERVICE jobscheduler:":
//
//   Job history:
//        -19m40s688ms START-P: #1000/1 @Ns@com.android.foo/.BarJobService
//        -19m40s409ms  STOP-P: #1000/1 @Ns@com.android.foo/.BarJobService
//                              onStartJob returned false
//
// Timestamps are relative to the time the service was dumped; we approximate
// that with the dumpstate start time. START/STOP pairs (matched on
// "#uid/jobid name") become slices on the "Job history" track; unmatched
// entries become instants.
class DumpsysJobSchedulerParser : public BugreportSectionParser {
 public:
  explicit DumpsysJobSchedulerParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    if (line == "  Job history:") {
      in_history_ = true;
      return base::OkStatus();
    }
    if (!in_history_) {
      return base::OkStatus();
    }
    // History lines are indented with 7 spaces; anything less indented ends
    // the block.
    base::StringView trimmed = TrimLeft(line);
    if (trimmed.empty() || trimmed.size() == line.size()) {
      in_history_ = false;
      return base::OkStatus();
    }

    // "-19m40s688ms START-P: #1000/1 <name> [reason]".
    size_t sp = trimmed.find(' ');
    if (sp == base::StringView::npos) {
      return base::OkStatus();
    }
    std::optional<int64_t> rel_ms =
        ParseAndroidDurationMs(trimmed.substr(0, sp));
    if (!rel_ms) {
      return base::OkStatus();
    }
    base::StringView rest = TrimLeft(trimmed.substr(sp + 1));
    bool is_start = false;
    if (rest.StartsWith("START")) {
      is_start = true;
    } else if (!rest.StartsWith("STOP")) {
      return base::OkStatus();
    }
    size_t colon = rest.find(": ");
    if (colon == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView marker = rest.substr(0, colon);
    rest = rest.substr(colon + 2);

    // rest is now "#1000/1 <name> [stop reason]". Note: <name> can itself
    // contain spaces (e.g. namespaces printed as "@class com.foo.Bar@..."),
    // so a START's name is the full remainder and STOP lines are matched by
    // prefix.
    size_t name_start = rest.find(' ');
    if (name_start == base::StringView::npos || rest.empty() ||
        rest.at(0) != '#') {
      return base::OkStatus();
    }
    base::StringView uid_jobid = rest.substr(1, name_start - 1);
    base::StringView name_and_reason = rest.substr(name_start + 1);

    if (is_start) {
      open_jobs_.push_back(OpenJob{uid_jobid.ToStdString(),
                                   name_and_reason.ToStdString(), *rel_ms});
      return base::OkStatus();
    }

    // STOP: find the most recent START with the same uid/jobid whose name is
    // a prefix of this line's "<name> [stop reason]" remainder.
    std::string name = name_and_reason.ToStdString();
    std::string reason;
    std::optional<int64_t> start_rel_ms;
    for (auto it = open_jobs_.rbegin(); it != open_jobs_.rend(); ++it) {
      if (base::StringView(it->uid_jobid) != uid_jobid) {
        continue;
      }
      base::StringView nr = name_and_reason;
      if (nr.StartsWith(base::StringView(it->name)) &&
          (nr.size() == it->name.size() || nr.at(it->name.size()) == ' ')) {
        start_rel_ms = it->start_rel_ms;
        name = it->name;
        if (nr.size() > it->name.size()) {
          reason = nr.substr(it->name.size() + 1).ToStdString();
        }
        open_jobs_.erase(std::next(it).base());
        break;
      }
    }

    if (!deps_.format->dumpstate_start_ms) {
      return base::OkStatus();
    }
    int64_t ref_ms = *deps_.format->dumpstate_start_ms;

    BugreportTimelineEvent event;
    event.track = "Job history";
    event.name = name;
    event.args.emplace_back("uid/job_id", uid_jobid.ToStdString());
    if (!reason.empty()) {
      event.args.emplace_back("stop_reason", reason);
    }
    event.args.emplace_back("marker", marker.ToStdString());
    if (start_rel_ms) {
      event.kind = BugreportTimelineEvent::Kind::kSlice;
      event.dur_ns = (*rel_ms - *start_rel_ms) * 1000 * 1000;
      deps_.emitter->Emit(ref_ms + *start_rel_ms, std::move(event));
    } else {
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      deps_.emitter->Emit(ref_ms + *rel_ms, std::move(event));
    }
    return base::OkStatus();
  }

  base::Status EndOfSection() override {
    // Jobs that started but never stopped within the history window become
    // instants (their end is unknown).
    if (deps_.format->dumpstate_start_ms) {
      int64_t ref_ms = *deps_.format->dumpstate_start_ms;
      for (const auto& job : open_jobs_) {
        BugreportTimelineEvent event;
        event.kind = BugreportTimelineEvent::Kind::kInstant;
        event.track = "Job history";
        event.name = job.name;
        event.args.emplace_back("uid/job_id", job.uid_jobid);
        event.args.emplace_back("marker", "START (no matching STOP)");
        deps_.emitter->Emit(ref_ms + job.start_rel_ms, std::move(event));
      }
    }
    open_jobs_.clear();
    return base::OkStatus();
  }

 private:
  struct OpenJob {
    std::string uid_jobid;
    std::string name;
    int64_t start_rel_ms;
  };

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  const BugreportParserDeps deps_;
  bool in_history_ = false;
  std::vector<OpenJob> open_jobs_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysJobSchedulerParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysJobSchedulerParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
