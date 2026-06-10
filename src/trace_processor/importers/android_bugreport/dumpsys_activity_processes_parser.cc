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

// Parses the time-based blocks of "DUMP OF SERVICE [CRITICAL] activity:"
// other than broadcast history (which DumpsysBroadcastsParser handles).
// Samples from SDK 36 (Baklava):
//
// "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)":
//   *APP* UID 1000 ProcessRecord{bd55b9c 4548:com.android.dynsystem/1000}
//     lastActivityTime=-19m26s316ms    startUpTime=-19m26s403ms    ...
// startUpTime is relative to dump time -> "Process starts" instants anchored
// at the dumpstate start time.
//
// "ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)":
//   timestamp=2026-06-10 09:02:15.502 pid=4010 realUid=10101 ...
//   process=com.android.devicelockcontroller reason=15 (STATE CHANGE) ...
// Wall-clock timestamps -> instants on "App errors" for crash/ANR reasons,
// on "Process exits" otherwise.
//
// "ACTIVITY MANAGER RECENT TASKS (dumpsys activity recents)":
//   * Recent #0: Task{7ec9f08 #9 type=standard A=10068:org.chromium...}
//     affinity=10068:org.chromium.webview_shell
//     mActivityComponent=org.chromium.webview_shell/.WebViewBrowserActivity
//     lastActiveTime=108033 (inactive for 1123s)
// lastActiveTime is raw elapsedRealtime (unanchorable), but "(inactive for
// Ns)" is relative to dump time -> "Recent tasks" instants at dumpstate
// start - N s. The "Visible recent tasks" RecentTaskInfo entries repeat
// lastActiveTime without that suffix and are skipped as duplicates.
//
// "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)", present in
// the CRITICAL dump:
//   * Hist  #0: ActivityRecord{261536939 u0 org.chromium.../.Browser... t9}
//     launchFailed=false launchCount=0 lastLaunchTime=-18m33s806ms
// lastLaunchTime is relative to dump time -> "Activity launches" instants.
//
// Skipped blocks (no absolutely anchorable timestamps):
// - "ACTIVITY MANAGER LRU PROCESSES (dumpsys activity start-info)":
//   ApplicationStartInfo monotonicCreationTimeMs / "timestamps:" values are
//   monotonic-since-boot with no wall-clock anchor in the dump (process
//   starts are covered by RUNNING PROCESSES startUpTime instead).
// - "ACTIVITY MANAGER LAST ANR": only the "<no ANR has occurred since boot>"
//   placeholder was observed; no timestamped record format to parse.
// - "ACTIVITY MANAGER LMK KILLS": aggregate kill counters, no timestamps.
// - "UID states:": UidRecords only carry "bg:+19m5s657ms" style durations
//   for some idle uids; their reference point is ambiguous.
class DumpsysActivityProcessesParser : public BugreportSectionParser {
 public:
  explicit DumpsysActivityProcessesParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.empty()) {
      return base::OkStatus();
    }
    if (t.size() == line.size()) {
      // Unindented: possibly a new "ACTIVITY MANAGER ..." sub-header. Other
      // unindented lines (e.g. "Display #0 ...") don't change the block.
      if (t.StartsWith("ACTIVITY MANAGER ")) {
        block_ = Block::kNone;
        if (t.StartsWith("ACTIVITY MANAGER RUNNING PROCESSES")) {
          block_ = Block::kProcesses;
        } else if (t.StartsWith("ACTIVITY MANAGER PROCESS EXIT INFO")) {
          block_ = Block::kExitInfo;
        } else if (t.StartsWith("ACTIVITY MANAGER RECENT TASKS")) {
          block_ = Block::kRecentTasks;
        } else if (t.StartsWith("ACTIVITY MANAGER ACTIVITIES")) {
          block_ = Block::kActivities;
        }
        ctx_ = Context();
      }
      return base::OkStatus();
    }
    switch (block_) {
      case Block::kProcesses:
        return ParseProcessLine(t);
      case Block::kExitInfo:
        return ParseExitInfoLine(t);
      case Block::kRecentTasks:
        return ParseRecentTaskLine(t);
      case Block::kActivities:
        return ParseActivityLine(t);
      case Block::kNone:
        break;
    }
    return base::OkStatus();
  }

 private:
  enum class Block { kNone, kProcesses, kExitInfo, kRecentTasks, kActivities };

  // Per-record context, reset at each record header. Fields are reused
  // across the (mutually exclusive) blocks.
  struct Context {
    bool active = false;
    std::string name;  // Process / component name.
    std::string aux;   // uid / affinity.
    std::string pid;
    std::optional<int64_t> ts_ms;  // Exit info wall-clock timestamp.
  };

  // "*APP* UID 1000 ProcessRecord{bd55b9c 4548:com.android.dynsystem/1000}".
  base::Status ParseProcessLine(base::StringView t) {
    if (t.StartsWith("*APP* UID ") || t.StartsWith("*PERS* UID ")) {
      ctx_ = Context();
      ctx_.aux = TokenUntilSpace(t.substr(t.find("UID ") + 4)).ToStdString();
      size_t brace = t.find("ProcessRecord{");
      if (brace == base::StringView::npos) {
        return base::OkStatus();
      }
      base::StringView rec = t.substr(brace + 14);
      size_t sp = rec.find(' ');
      size_t colon = sp == base::StringView::npos ? sp : rec.find(':', sp);
      size_t slash =
          colon == base::StringView::npos ? colon : rec.find('/', colon);
      if (slash == base::StringView::npos) {
        return base::OkStatus();
      }
      ctx_.pid = rec.substr(sp + 1, colon - sp - 1).ToStdString();
      ctx_.name = rec.substr(colon + 1, slash - colon - 1).ToStdString();
      ctx_.active = true;
      return base::OkStatus();
    }
    size_t pos = t.find("startUpTime=");
    if (!ctx_.active || pos == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView raw = TokenUntilSpace(t.substr(pos + 12));
    if (std::optional<int64_t> rel_ms = ParseAndroidDurationMs(raw)) {
      BugreportTimelineEvent event;
      event.track = "Process starts";
      event.name = ctx_.name;
      event.args.emplace_back("pid", ctx_.pid);
      event.args.emplace_back("uid", ctx_.aux);
      event.args.emplace_back("start_up_time", raw.ToStdString());
      EmitRelativeToDump(*rel_ms, std::move(event));
    }
    ctx_ = Context();
    return base::OkStatus();
  }

  // "timestamp=2026-06-10 09:02:15.502 pid=4010 realUid=10101 ..." followed
  // by "process=<name> reason=15 (STATE CHANGE) subreason=0 (UNKNOWN) ...".
  base::Status ParseExitInfoLine(base::StringView t) {
    if (t.StartsWith("timestamp=")) {
      ctx_ = Context();
      base::StringView v = t.substr(10);
      size_t pid = v.find(" pid=");
      ctx_.ts_ms = ParseIsoDateTimeMs(v.substr(0, pid));  // substr clamps.
      if (!ctx_.ts_ms || pid == base::StringView::npos) {
        return base::OkStatus();
      }
      ctx_.pid = TokenUntilSpace(v.substr(pid + 5)).ToStdString();
      size_t uid = v.find(" realUid=");
      if (uid != base::StringView::npos) {
        ctx_.aux = TokenUntilSpace(v.substr(uid + 9)).ToStdString();
      }
      ctx_.active = true;
      return base::OkStatus();
    }
    if (!ctx_.active || !t.StartsWith("process=")) {
      return base::OkStatus();
    }
    base::StringView reason;
    size_t rpos = t.find(" reason=");
    if (rpos != base::StringView::npos) {
      reason = t.substr(rpos + 8, t.find(" subreason") - rpos - 8);
    }
    bool is_error = reason.find("CRASH") != base::StringView::npos ||
                    reason.find("ANR") != base::StringView::npos;
    BugreportTimelineEvent event;
    event.track = is_error ? "App errors" : "Process exits";
    event.name = TokenUntilSpace(t.substr(8)).ToStdString();
    event.args.emplace_back("pid", ctx_.pid);
    event.args.emplace_back("uid", ctx_.aux);
    event.args.emplace_back("reason", reason.ToStdString());
    deps_.emitter->Emit(*ctx_.ts_ms, std::move(event));
    ctx_ = Context();
    return base::OkStatus();
  }

  // "* Recent #0: Task{...}" + "affinity=" / "mActivityComponent=" /
  // "lastActiveTime=108033 (inactive for 1123s)" detail lines.
  base::Status ParseRecentTaskLine(base::StringView t) {
    if (t.StartsWith("* Recent #")) {
      ctx_ = Context();
      ctx_.active = true;
      return base::OkStatus();
    }
    if (!ctx_.active) {
      return base::OkStatus();
    }
    if (t.StartsWith("affinity=")) {
      ctx_.aux = t.substr(9).ToStdString();
    } else if (t.StartsWith("mActivityComponent=")) {
      ctx_.name = t.substr(19).ToStdString();
    } else if (t.StartsWith("lastActiveTime=")) {
      size_t pos = t.find("(inactive for ");
      size_t end = pos == base::StringView::npos ? pos : t.find("s)", pos);
      if (end != base::StringView::npos) {
        std::optional<int64_t> sec = base::StringToInt64(
            t.substr(pos + 14, end - pos - 14).ToStdString());
        if (sec && !(ctx_.name.empty() && ctx_.aux.empty())) {
          BugreportTimelineEvent event;
          event.track = "Recent tasks";
          event.name = ctx_.name.empty() ? ctx_.aux : ctx_.name;
          event.args.emplace_back("affinity", ctx_.aux);
          event.args.emplace_back("inactive_for", t.substr(pos).ToStdString());
          EmitRelativeToDump(-*sec * 1000, std::move(event));
        }
      }
      ctx_ = Context();
    }
    return base::OkStatus();
  }

  // "* Hist  #0: ActivityRecord{261536939 u0 <component> t9}" followed
  // (later in the record) by "launchFailed=... lastLaunchTime=-18m33s806ms".
  base::Status ParseActivityLine(base::StringView t) {
    if (t.StartsWith("* Hist ")) {
      ctx_ = Context();
      size_t brace = t.find("ActivityRecord{");
      if (brace == base::StringView::npos) {
        return base::OkStatus();
      }
      // The third space-separated token between the braces is the component.
      base::StringView rec = t.substr(brace + 15);
      rec = rec.substr(0, rec.find('}'));
      size_t s1 = rec.find(' ');
      size_t s2 = s1 == base::StringView::npos ? s1 : rec.find(' ', s1 + 1);
      if (s2 == base::StringView::npos) {
        return base::OkStatus();
      }
      ctx_.name = TokenUntilSpace(rec.substr(s2 + 1)).ToStdString();
      ctx_.active = true;
      return base::OkStatus();
    }
    size_t pos = t.find("lastLaunchTime=");
    if (!ctx_.active || !t.StartsWith("launchFailed=") ||
        pos == base::StringView::npos) {
      return base::OkStatus();
    }
    base::StringView raw = TokenUntilSpace(t.substr(pos + 15));
    if (std::optional<int64_t> rel_ms = ParseAndroidDurationMs(raw)) {
      BugreportTimelineEvent event;
      event.track = "Activity launches";
      event.name = ctx_.name;
      event.args.emplace_back("last_launch_time", raw.ToStdString());
      EmitRelativeToDump(*rel_ms, std::move(event));
    }
    ctx_ = Context();
    return base::OkStatus();
  }

  void EmitRelativeToDump(int64_t rel_ms, BugreportTimelineEvent event) {
    if (!deps_.format->dumpstate_start_ms) {
      return;
    }
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    deps_.emitter->Emit(*deps_.format->dumpstate_start_ms + rel_ms,
                        std::move(event));
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static base::StringView TokenUntilSpace(base::StringView sv) {
    return sv.substr(0, sv.find(' '));  // substr clamps npos.
  }

  const BugreportParserDeps deps_;
  Block block_ = Block::kNone;
  Context ctx_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysActivityProcessesParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysActivityProcessesParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
