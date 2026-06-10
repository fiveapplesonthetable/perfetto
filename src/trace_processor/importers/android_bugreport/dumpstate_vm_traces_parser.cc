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

// Parses the "VM TRACES JUST NOW" / "VM TRACES AT LAST ANR" dumpstate
// sections, which concatenate per-process stack dumps delimited as (SDK 36,
// Baklava):
//
//   ----- pid 545 at 2026-06-10 09:21:18.941779611+0000 -----
//   Cmd line: /system/bin/vold --blkid_context=u:r:blkid:s0 ...
//   ABI: 'x86_64'
//   ...stack dump...
//   ----- end 545 -----
//
// Native processes additionally get a kernel wchan dump with a
// "----- Waiting Channels: pid 545 at ... -----" header, which is skipped
// (same pid, near-identical timestamp). Each pid header becomes an instant
// on the "Stack dumps" track, named after the process cmdline.
class DumpstateVmTracesParser : public BugreportSectionParser {
 public:
  explicit DumpstateVmTracesParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    static constexpr char kPidPrefix[] = "----- pid ";
    if (line.StartsWith(kPidPrefix)) {
      pending_ts_ms_ = std::nullopt;
      lines_since_header_ = 0;
      // "----- pid 545 at 2026-06-10 09:21:18.941779611+0000 -----".
      base::StringView rest = line.substr(sizeof(kPidPrefix) - 1);
      size_t at = rest.find(" at ");
      size_t tail = rest.find(" -----", at == base::StringView::npos ? 0 : at);
      if (at == base::StringView::npos || tail == base::StringView::npos ||
          tail <= at + 4) {
        return base::OkStatus();
      }
      base::StringView ts = rest.substr(at + 4, tail - (at + 4));
      // Strip a trailing "+0000" / "-0800" timezone suffix: the printed time
      // is already local time, ParseIsoDateTimeMs only takes the date part.
      if (ts.size() > 5 &&
          (ts.at(ts.size() - 5) == '+' || ts.at(ts.size() - 5) == '-')) {
        ts = ts.substr(0, ts.size() - 5);
      }
      std::optional<int64_t> ts_ms = ParseIsoDateTimeMs(ts);
      if (!ts_ms) {
        return base::OkStatus();
      }
      pending_ts_ms_ = ts_ms;
      pending_pid_ = rest.substr(0, at).ToStdString();
      return base::OkStatus();
    }

    if (!pending_ts_ms_) {
      return base::OkStatus();
    }
    static constexpr char kCmdLinePrefix[] = "Cmd line: ";
    if (line.StartsWith(kCmdLinePrefix)) {
      std::string cmdline =
          line.substr(sizeof(kCmdLinePrefix) - 1).ToStdString();
      // Name the instant after the process: first token of the cmdline,
      // basename only if it's a path (e.g. "/system/bin/vold --x" -> "vold").
      std::string name = cmdline.substr(0, cmdline.find(' '));
      size_t slash = name.rfind('/');
      if (slash != std::string::npos) {
        name = name.substr(slash + 1);
      }
      BugreportTimelineEvent event;
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      event.track = "Stack dumps";
      event.name = std::move(name);
      event.args.emplace_back("pid", pending_pid_);
      event.args.emplace_back("cmdline", std::move(cmdline));
      deps_.emitter->Emit(*pending_ts_ms_, std::move(event));
      pending_ts_ms_ = std::nullopt;
      return base::OkStatus();
    }
    // "Cmd line:" is normally the very next line; give up after a few.
    if (++lines_since_header_ > 3) {
      pending_ts_ms_ = std::nullopt;
    }
    return base::OkStatus();
  }

 private:
  const BugreportParserDeps deps_;
  std::optional<int64_t> pending_ts_ms_;
  std::string pending_pid_;
  int lines_since_header_ = 0;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateVmTracesParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpstateVmTracesParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
