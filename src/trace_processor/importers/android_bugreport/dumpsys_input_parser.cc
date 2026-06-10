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
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_utils.h"
#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses "DUMP OF SERVICE input:" (and the "DUMP OF SERVICE CRITICAL input:"
// variant). As of SDK 36 (Baklava) the InputDispatcher state dump prints the
// recently dispatched events ("RecentQueue"), the queued ones ("InboundQueue",
// "PendingEvent") and the per-connection "OutboundQueue" / "WaitQueue", all
// using KeyEntry/MotionEntry::getDescription() (debuggable builds only):
//
//   RecentQueue: length=10
//     KeyEvent(deviceId=-1, eventTime=92985000000ns, source=UNKNOWN,
//     displayId=-1, action=DOWN, flags=0x00000000, keyCode=HOME(3),
//     scanCode=0, metaState=0x00000000, repeatCount=0),
//     policyFlags=0x6b000000, age=1115346ms
//
//   MotionEvent(deviceId=2, eventTime=1597899220062000ns, source=TOUCHSCREEN,
//   displayId=0,action=DOWN, actionButton=0x00000000, flags=0x00000000, ...,
//   pointers=[0: (735.0, 1015.0)]), policyFlags=0x62000000, age=100ms
//
// eventTime is elapsedRealtime in nanoseconds, so each entry becomes a
// kInstant on the "Input events" track via EmitAtElapsed (anchored once the
// alarm dump's nowRTC/nowELAPSED line is seen). The same physical event can
// sit in several queues at once (e.g. RecentQueue and a connection's
// WaitQueue); entries are deduped on (event type, eventTime).
class DumpsysInputParser : public BugreportSectionParser {
 public:
  explicit DumpsysInputParser(const BugreportParserDeps& deps) : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t.StartsWith("KeyEvent(")) {
      ParseEntry(t, /*is_motion=*/false);
    } else if (t.StartsWith("MotionEvent(")) {
      ParseEntry(t, /*is_motion=*/true);
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

  // Returns the value of "<key>=" in `t`, up to the next ',' or unbalanced
  // ')' (values like "keyCode=HOME(3)" or "action=POINTER_DOWN(1)" contain
  // balanced parentheses of their own).
  static base::StringView ExtractField(base::StringView t, const char* key) {
    size_t pos = t.find(key);
    if (pos == base::StringView::npos)
      return base::StringView();
    size_t start = pos + strlen(key);
    size_t end = start;
    int depth = 0;
    for (; end < t.size(); ++end) {
      char c = t.at(end);
      if (c == ',' || (c == ')' && depth == 0))
        break;
      if (c == '(')
        ++depth;
      else if (c == ')')
        --depth;
    }
    return t.substr(start, end - start);
  }

  // `t` is the left-trimmed queue entry line. Entries on release (i.e.
  // non-debuggable) builds are printed as a bare "KeyEvent" / "MotionEvent"
  // with no fields; those are skipped (no timestamp to anchor).
  void ParseEntry(base::StringView t, bool is_motion) {
    base::StringView event_time = ExtractField(t, "eventTime=");
    if (!event_time.EndsWith("ns"))
      return;
    std::optional<int64_t> ns = base::StringToInt64(
        event_time.substr(0, event_time.size() - 2).ToStdString());
    if (!ns || *ns < 0)
      return;
    // One physical event can be queued in several dumped lists; emit once.
    if (!seen_.insert(std::make_pair(*ns, is_motion)).second)
      return;

    base::StringView action = ExtractField(t, "action=");
    base::StringView device = ExtractField(t, "deviceId=");
    base::StringView source = ExtractField(t, "source=");
    base::StringView key_code = ExtractField(t, "keyCode=");

    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Input events";
    event.name = is_motion ? "MotionEvent" : "KeyEvent";
    if (!action.empty()) {
      event.name += " " + action.ToStdString();
    }
    if (!is_motion && !key_code.empty()) {
      // "keyCode=HOME(3)": append the key label only.
      size_t paren = key_code.find('(');
      event.name +=
          " " + (paren == base::StringView::npos ? key_code
                                                 : key_code.substr(0, paren))
                    .ToStdString();
    }
    if (!device.empty())
      event.args.emplace_back("device", device.ToStdString());
    if (!is_motion && !key_code.empty())
      event.args.emplace_back("keyCode", key_code.ToStdString());
    if (!action.empty())
      event.args.emplace_back("action", action.ToStdString());
    if (!source.empty())
      event.args.emplace_back("source", source.ToStdString());
    event.args.emplace_back("raw", t.ToStdString());
    deps_.emitter->EmitAtElapsed(*ns / 1000000, std::move(event));
  }

  const BugreportParserDeps deps_;
  // (eventTime ns, is MotionEvent) of already-emitted entries.
  std::set<std::pair<int64_t, bool>> seen_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysInputParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysInputParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
