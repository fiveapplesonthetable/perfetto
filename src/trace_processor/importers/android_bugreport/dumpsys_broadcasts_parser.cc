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
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses the broadcast history of "DUMP OF SERVICE activity:" ("ACTIVITY
// MANAGER BROADCAST STATE" sub-section). Sample from SDK 36 (Baklava):
//
//   Historical broadcasts:
//   Historical Broadcast #0:
//     BroadcastRecord{a30a3b4 android.intent.action.PACKAGE_UNSTOPPED/u0} ...
//     Intent { act=android.intent.action.PACKAGE_UNSTOPPED flg=0x44000010 }
//     enqueueClockTime=2026-06-10 09:02:43.646 dispatchClockTime=2026-06-...
//     dispatchTime=-18m57s323ms (+1ms since enq) finishTime=-23s369ms (...)
//     terminalCount=3
//   ...
//   Historical broadcasts summary:
//   #0: act=android.intent.action.PACKAGE_UNSTOPPED flg=0x44000010
//     +1ms dispatch +18m33s954ms finish
//     enq=2026-06-10 09:02:43.646 disp=2026-06-10 ... fin=2026-06-10 ...
//
// On older releases (per-queue BroadcastQueueImpl) the headers also name a
// queue: "Historical Broadcast foreground #0:" and "Summary of historical
// broadcasts [foreground]:". The queue name, when present, selects the track
// ("Broadcasts (foreground)" etc.); the modern unified queue uses just
// "Broadcasts".
//
// Full records and summary entries describe the same history with different
// caps (bcast_max_history_complete_size=256 vs summary_size=1024): on a busy
// device the full records cover only the most recent entries while the
// summary covers up to 4x more, and both carry complete wall-clock
// timestamps. Deduping the overlap is fragile, so both sets are buffered and
// at the end of the section we emit whichever produced more events,
// preferring full records on a tie since they carry more detail
// (BroadcastRecord line, receiver count).
class DumpsysBroadcastsParser : public BugreportSectionParser {
 public:
  explicit DumpsysBroadcastsParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.empty()) {
      return base::OkStatus();
    }
    if (t.size() == line.size()) {
      // Unindented line: a new "ACTIVITY MANAGER ..." sub-header or section
      // separator; any broadcast block is over.
      FlushRecord();
      in_summary_ = false;
      return base::OkStatus();
    }
    if (t.StartsWith("Historical Broadcast ") && t.EndsWith(":")) {
      FlushRecord();
      in_summary_ = false;
      // "Historical Broadcast <queue >#N:". The queue name is absent on the
      // modern (SDK >= 33) unified queue.
      base::StringView rest = t.substr(21, t.size() - 22);
      size_t hash = rest.rfind('#');
      if (hash == base::StringView::npos) {
        return base::OkStatus();
      }
      record_.active = true;
      record_.queue = TrimRight(rest.substr(0, hash)).ToStdString();
      return base::OkStatus();
    }
    if (t.StartsWith("Historical broadcasts summary") ||
        t.StartsWith("Summary of historical broadcasts")) {
      FlushRecord();
      in_summary_ = true;
      summary_pending_ = false;
      // Legacy form names the queue in brackets.
      summary_queue_.clear();
      size_t lb = t.find('[');
      size_t rb = t.find(']');
      if (lb != base::StringView::npos && rb != base::StringView::npos &&
          rb > lb) {
        summary_queue_ = t.substr(lb + 1, rb - lb - 1).ToStdString();
      }
      return base::OkStatus();
    }
    if (in_summary_) {
      return ParseSummaryLine(t);
    }
    if (record_.active) {
      return ParseRecordLine(t);
    }
    return base::OkStatus();
  }

  base::Status EndOfSection() override {
    FlushRecord();
    auto& events = full_events_.size() >= summary_events_.size()
                       ? full_events_
                       : summary_events_;
    for (auto& [wall_ms, event] : events) {
      deps_.emitter->Emit(wall_ms, std::move(event));
    }
    full_events_.clear();
    summary_events_.clear();
    return base::OkStatus();
  }

 private:
  struct PendingRecord {
    bool active = false;
    std::string queue;
    std::string record_line;  // The "BroadcastRecord{...}" line, trimmed.
    std::string action;
    std::string enqueue_raw;
    std::optional<int64_t> enqueue_ms;
    std::optional<int64_t> dispatch_clock_ms;
    std::optional<int64_t> dispatch_rel_ms;
    std::optional<int64_t> finish_rel_ms;
    std::string receivers;
  };

  base::Status ParseRecordLine(base::StringView t) {
    if (t.StartsWith("BroadcastRecord{") && record_.record_line.empty()) {
      record_.record_line = t.ToStdString();
    } else if (t.StartsWith("Intent {") && record_.action.empty()) {
      size_t act = t.find("act=");
      if (act != base::StringView::npos) {
        record_.action = TokenUntilSpace(t.substr(act + 4)).ToStdString();
      }
    } else if (t.StartsWith("enqueueClockTime=")) {
      base::StringView v = t.substr(17);
      size_t disp = v.find(" dispatchClockTime=");
      base::StringView enq = v.substr(0, disp);  // substr clamps npos.
      record_.enqueue_raw = enq.ToStdString();
      record_.enqueue_ms = ParseIsoDateTimeMs(enq);
      if (disp != base::StringView::npos) {
        record_.dispatch_clock_ms = ParseIsoDateTimeMs(v.substr(disp + 19));
      }
    } else if (t.StartsWith("dispatchTime=")) {
      record_.dispatch_rel_ms =
          ParseAndroidDurationMs(TokenUntilSpace(t.substr(13)));
      size_t fin = t.find("finishTime=");
      if (fin != base::StringView::npos) {
        record_.finish_rel_ms =
            ParseAndroidDurationMs(TokenUntilSpace(t.substr(fin + 11)));
      }
    } else if (t.StartsWith("terminalCount=")) {
      record_.receivers = t.substr(14).ToStdString();
    }
    return base::OkStatus();
  }

  // Materializes the in-flight full record (if any) into full_events_.
  // Malformed records are dropped silently.
  void FlushRecord() {
    if (!record_.active) {
      return;
    }
    PendingRecord r = std::move(record_);
    record_ = PendingRecord();
    if (r.action.empty()) {
      // Fall back to "BroadcastRecord{hash <action>/uN}": last token between
      // the braces, minus the "/uN" user suffix.
      base::StringView rl = base::StringView(r.record_line);
      size_t close = rl.find('}');
      rl = rl.substr(0, close);
      size_t sp = rl.rfind(' ');
      if (sp != base::StringView::npos) {
        base::StringView a = rl.substr(sp + 1);
        r.action = a.substr(0, a.find('/')).ToStdString();
      }
    }
    if (r.action.empty()) {
      return;
    }

    BugreportTimelineEvent event;
    event.track = TrackName(r.queue);
    event.name = r.action;
    if (!r.queue.empty()) {
      event.args.emplace_back("queue", r.queue);
    }
    if (!r.enqueue_raw.empty()) {
      event.args.emplace_back("enqueue_time", r.enqueue_raw);
    }
    if (!r.record_line.empty()) {
      event.args.emplace_back("record", r.record_line);
    }
    if (!r.receivers.empty()) {
      event.args.emplace_back("receivers", r.receivers);
    }
    if (r.dispatch_clock_ms) {
      event.kind = BugreportTimelineEvent::Kind::kSlice;
      if (r.dispatch_rel_ms && r.finish_rel_ms) {
        int64_t dur_ms = *r.finish_rel_ms - *r.dispatch_rel_ms;
        event.dur_ns = dur_ms > 0 ? dur_ms * 1000 * 1000 : 0;
      }
      full_events_.emplace_back(*r.dispatch_clock_ms, std::move(event));
    } else if (r.enqueue_ms) {
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      full_events_.emplace_back(*r.enqueue_ms, std::move(event));
    }
  }

  base::Status ParseSummaryLine(base::StringView t) {
    if (t.at(0) == '#') {
      // "#0: act=android.intent.action.X flg=0x... (has extras)".
      size_t colon = t.find(": act=");
      if (colon == base::StringView::npos || colon < 2) {
        return base::OkStatus();
      }
      for (size_t i = 1; i < colon; ++i) {
        if (t.at(i) < '0' || t.at(i) > '9') {
          return base::OkStatus();
        }
      }
      summary_pending_ = true;
      summary_record_ = t.ToStdString();
      summary_action_ = TokenUntilSpace(t.substr(colon + 6)).ToStdString();
      return base::OkStatus();
    }
    if (!summary_pending_ || !t.StartsWith("enq=")) {
      return base::OkStatus();
    }
    // "enq=2026-06-10 09:02:43.646 disp=... fin=...".
    summary_pending_ = false;
    size_t disp = t.find(" disp=");
    size_t fin = t.find(" fin=");
    base::StringView enq_raw = t.substr(4, disp - 4);  // substr clamps npos.
    std::optional<int64_t> enq_ms = ParseIsoDateTimeMs(enq_raw);
    std::optional<int64_t> disp_ms;
    std::optional<int64_t> fin_ms;
    if (disp != base::StringView::npos && fin != base::StringView::npos &&
        fin > disp) {
      disp_ms = ParseIsoDateTimeMs(t.substr(disp + 6, fin - disp - 6));
      fin_ms = ParseIsoDateTimeMs(t.substr(fin + 5));
    }
    if (summary_action_.empty()) {
      return base::OkStatus();
    }

    BugreportTimelineEvent event;
    event.track = TrackName(summary_queue_);
    event.name = summary_action_;
    if (!summary_queue_.empty()) {
      event.args.emplace_back("queue", summary_queue_);
    }
    event.args.emplace_back("enqueue_time", enq_raw.ToStdString());
    event.args.emplace_back("record", summary_record_);
    if (disp_ms) {
      event.kind = BugreportTimelineEvent::Kind::kSlice;
      if (fin_ms && *fin_ms > *disp_ms) {
        event.dur_ns = (*fin_ms - *disp_ms) * 1000 * 1000;
      }
      summary_events_.emplace_back(*disp_ms, std::move(event));
    } else if (enq_ms) {
      event.kind = BugreportTimelineEvent::Kind::kInstant;
      summary_events_.emplace_back(*enq_ms, std::move(event));
    }
    return base::OkStatus();
  }

  static std::string TrackName(const std::string& queue) {
    return queue.empty() ? "Broadcasts" : "Broadcasts (" + queue + ")";
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  static base::StringView TrimRight(base::StringView sv) {
    size_t n = sv.size();
    while (n > 0 && sv.at(n - 1) == ' ')
      --n;
    return sv.substr(0, n);
  }

  static base::StringView TokenUntilSpace(base::StringView sv) {
    return sv.substr(0, sv.find(' '));  // substr clamps npos.
  }

  const BugreportParserDeps deps_;
  PendingRecord record_;
  bool in_summary_ = false;
  bool summary_pending_ = false;
  std::string summary_queue_;
  std::string summary_record_;
  std::string summary_action_;
  std::vector<std::pair<int64_t, BugreportTimelineEvent>> full_events_;
  std::vector<std::pair<int64_t, BugreportTimelineEvent>> summary_events_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysBroadcastsParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysBroadcastsParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
