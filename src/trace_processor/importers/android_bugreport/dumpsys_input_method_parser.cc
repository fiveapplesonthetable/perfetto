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

// Parses "DUMP OF SERVICE input_method:" (and the "DUMP OF SERVICE CRITICAL
// input_method:" variant). As of SDK 36 (Baklava) three history blocks carry
// wall-clock timestamps:
//
//   mImeTrackerService#History:
//     mCompletedEntries: 1 elements
//       #0 TYPE_HIDE - STATUS_FAIL - org.chromium.webview_shell:75531502 (4ms):
//         startTime=2026-06-10 09:02:44.062 (timestamp=94524) ORIGIN_CLIENT
//         reason=HIDE_SOFT_INPUT PHASE_CLIENT_VIEW_SERVED
//         requestWindowName=not set
//
//   mStartInputHistory:
//     StartInput #57:
//       time=2026-06-10 09:02:44.062 (timestamp=94524) reason=WINDOW_FOCUS_GAIN
//       restarting=false
//       targetWin=... [org.chromium.webview_shell] targetUserId=0 ...
//
//   mSoftInputShowHideHistory:
//     SoftInputShowHide[0] #5:
//       time=2026-06-10 09:02:44.062 (timestamp=94524)
//       reason=HIDE_SOFT_INPUT inFullscreenMode=false
//       requestWindowName=...
//
// Each entry becomes a kInstant on the "IME" track at its wall-clock time
// (the "(timestamp=...)" value is elapsedRealtime ms, redundant with it).
class DumpsysInputMethodParser : public BugreportSectionParser {
 public:
  explicit DumpsysInputMethodParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    // Entry headers. Each starts a new pending entry (flushing the previous).
    if (t.StartsWith("#") && t.find(" TYPE_") != base::StringView::npos &&
        EndsWithColon(t)) {
      FlushPending();
      ParseImeTrackerHeader(t);
    } else if (t.StartsWith("StartInput #") && EndsWithColon(t)) {
      FlushPending();
      StartEntry("StartInput");
    } else if (t.StartsWith("SoftInputShowHide") && EndsWithColon(t)) {
      FlushPending();
      StartEntry("SoftInput");
    } else if (pending_) {
      ParseDetailLine(t);
    }
    return base::OkStatus();
  }

  base::Status EndOfSection() override {
    FlushPending();
    return base::OkStatus();
  }

 private:
  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static bool EndsWithColon(base::StringView sv) {
    return !sv.empty() && sv.at(sv.size() - 1) == ':';
  }

  void StartEntry(const char* kind) {
    pending_ = BugreportTimelineEvent();
    pending_->kind = BugreportTimelineEvent::Kind::kInstant;
    pending_->track = "IME";
    pending_->name = kind;
    wall_ms_.reset();
  }

  // "#0 TYPE_HIDE - STATUS_FAIL - org.chromium.webview_shell:75531502 (4ms):"
  void ParseImeTrackerHeader(base::StringView t) {
    size_t sp = t.find(' ');
    size_t sep1 = t.find(" - ");
    if (sp == base::StringView::npos || sep1 == base::StringView::npos ||
        sep1 < sp) {
      return;
    }
    base::StringView type = t.substr(sp + 1, sep1 - sp - 1);
    size_t sep2 = t.find(" - ", sep1 + 3);
    if (sep2 == base::StringView::npos)
      return;
    base::StringView status = t.substr(sep1 + 3, sep2 - sep1 - 3);
    base::StringView tag = t.substr(sep2 + 3);
    size_t paren = tag.find(" (");
    if (paren != base::StringView::npos)
      tag = tag.substr(0, paren);

    // Name "HIDE"/"SHOW"; the origin is appended from the startTime= line.
    if (type.StartsWith("TYPE_"))
      type = type.substr(5);
    StartEntry(type.ToStdString().c_str());
    pending_->args.emplace_back("status", status.ToStdString());
    pending_->args.emplace_back("component", tag.ToStdString());
  }

  void ParseDetailLine(base::StringView t) {
    // ImeTracker: "startTime=2026-06-10 09:02:44.062 (timestamp=94524)
    // ORIGIN_CLIENT"; StartInput / SoftInputShowHide use "time=" instead
    // (with "reason=... restarting=..." appended for StartInput).
    bool is_start_time = t.StartsWith("startTime=");
    if (is_start_time || t.StartsWith("time=")) {
      base::StringView rest = t.substr(is_start_time ? 10 : 5);
      size_t paren = rest.find(" (");
      if (paren == base::StringView::npos)
        return;
      wall_ms_ = ParseIsoDateTimeMs(rest.substr(0, paren));
      size_t close = rest.find(") ", paren);
      if (close != base::StringView::npos) {
        // ImeTracker: " ORIGIN_CLIENT". StartInput: " reason=... ...".
        base::StringView suffix = rest.substr(close + 2);
        if (suffix.StartsWith("ORIGIN_")) {
          pending_->name += " " + suffix.ToStdString();
        } else if (suffix.StartsWith("reason=")) {
          size_t end = suffix.find(' ');
          pending_->name += " " + suffix
                                      .substr(7, end == base::StringView::npos
                                                     ? base::StringView::npos
                                                     : end - 7)
                                      .ToStdString();
        }
      }
      return;
    }
    // ImeTracker: "reason=HIDE_SOFT_INPUT PHASE_CLIENT_VIEW_SERVED".
    // SoftInputShowHide: "reason=HIDE_SOFT_INPUT inFullscreenMode=false".
    if (t.StartsWith("reason=")) {
      size_t sp = t.find(' ');
      base::StringView reason = t.substr(
          7, sp == base::StringView::npos ? base::StringView::npos : sp - 7);
      if (pending_->name == "SoftInput")
        pending_->name += " " + reason.ToStdString();
      else
        pending_->args.emplace_back("reason", reason.ToStdString());
      if (sp != base::StringView::npos &&
          t.substr(sp + 1).StartsWith("PHASE_")) {
        base::StringView phase = t.substr(sp + 1);
        size_t end = phase.find(' ');  // Drops " lastProgressTime=..." tails.
        pending_->args.emplace_back("phase",
                                    phase.substr(0, end).ToStdString());
      }
      return;
    }
    // StartInput: "targetWin=2e1d0b2 [org.chromium.webview_shell] ...".
    if (t.StartsWith("targetWin=")) {
      size_t open = t.find('[');
      size_t close = t.find(']', open == base::StringView::npos ? 0 : open);
      if (open != base::StringView::npos && close != base::StringView::npos) {
        pending_->args.emplace_back(
            "component", t.substr(open + 1, close - open - 1).ToStdString());
      }
      return;
    }
    // Last captured field of ImeTracker / SoftInputShowHide entries: flush
    // eagerly so unrelated later lines cannot leak into the entry.
    if (t.StartsWith("requestWindowName=")) {
      base::StringView name = t.substr(18);
      if (!name.empty() && name != "not set")
        pending_->args.emplace_back("requestWindowName", name.ToStdString());
      FlushPending();
    }
  }

  void FlushPending() {
    if (pending_ && wall_ms_)
      deps_.emitter->Emit(*wall_ms_, std::move(*pending_));
    pending_.reset();
    wall_ms_.reset();
  }

  const BugreportParserDeps deps_;
  std::optional<BugreportTimelineEvent> pending_;
  std::optional<int64_t> wall_ms_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysInputMethodParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysInputMethodParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
