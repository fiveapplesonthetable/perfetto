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
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"
#include "src/trace_processor/importers/common/clock_tracker.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

// Parses "DUMP OF SERVICE notification:" / "DUMP OF SERVICE CRITICAL
// notification:". In bugreports the "Notification List:" (currently posted
// notifications) is part of the CRITICAL pass; the NORMAL-priority dump skips
// it (NotificationManagerService.dumpImpl gates dumpNotificationRecords on
// !filter.normalPriority). As of SDK 36 (Baklava, BP4A.251205.006) records
// are printed by NotificationRecord.dump() as:
//
//   Notification List:
//     NotificationRecord(0x0eaa384f: pkg=com.android.systemui
//     user=UserHandle{0} id=1397773634 tag=public:253,33 importance=2
//     key=0|com.android.systemui|...|10088: Notification(channel=DSK
//     shortcut=null ... vis=PUBLIC))
//       uid=10088 userId=0
//       ...
//       mCreationTimeMs=1781082133652
//
// The same record format follows an "Enqueued Notification List:" header for
// not-yet-posted notifications. Each record becomes a kInstant on the
// "Notifications" track at its creation time, named after the package.
//
// The "mArchive=" recently-dismissed history is NOT parsed: Archive.dumpImpl
// prints bare StatusBarNotification.toString() lines ("StatusBarNotification(
// pkg=... user=... id=... tag=... key=...: Notification(...))") which carry
// no timestamp at all.
//
// mCreationTimeMs is a raw System.currentTimeMillis() value (UTC epoch ms),
// whereas the emitter expects wall-clock ms in the device-local timezone. The
// tz offset (derived from the alarm dump's "nowRTC=" line) usually becomes
// known only later in the file; it is applied here when already available and
// otherwise the raw epoch value is used (exact on UTC devices, shifted by the
// tz offset elsewhere).
class DumpsysNotificationParser : public BugreportSectionParser {
 public:
  explicit DumpsysNotificationParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    base::StringView t = TrimLeft(line);
    if (t == "Notification List:") {
      list_ = "posted";
      has_record_ = false;
      return base::OkStatus();
    }
    if (t == "Enqueued Notification List:") {
      list_ = "enqueued";
      has_record_ = false;
      return base::OkStatus();
    }
    if (t.StartsWith("NotificationRecord(0x")) {
      ParseRecordHeader(t);
      return base::OkStatus();
    }
    if (!has_record_) {
      return base::OkStatus();
    }
    if (t.StartsWith("uid=")) {  // "uid=10088 userId=0".
      size_t sp = t.find(' ');
      uid_ =
          t.substr(4, sp == base::StringView::npos ? sp : sp - 4).ToStdString();
      return base::OkStatus();
    }
    if (t.StartsWith("mCreationTimeMs=")) {
      EmitRecord(t.substr(16));
      has_record_ = false;
    }
    return base::OkStatus();
  }

 private:
  // Returns the substring of `t` between `key` and `end_key` ("" on miss).
  static std::string Field(base::StringView t,
                           base::StringView key,
                           base::StringView end_key) {
    size_t b = t.find(key);
    if (b == base::StringView::npos)
      return "";
    b += key.size();
    size_t e = t.find(end_key, b);
    if (e == base::StringView::npos)
      return "";
    return t.substr(b, e - b).ToStdString();
  }

  // "NotificationRecord(0x...: pkg=<pkg> user=UserHandle{0} id=<id>
  // tag=<tag> importance=<n> key=<key>: Notification(channel=<channel> ...".
  void ParseRecordHeader(base::StringView t) {
    pkg_ = Field(t, " pkg=", " user=");
    id_ = Field(t, " id=", " tag=");
    tag_ = Field(t, " tag=", " importance=");
    channel_ = Field(t, "Notification(channel=", " ");
    uid_.clear();
    has_record_ = !pkg_.empty();
  }

  // `value` is the digits after "mCreationTimeMs=": epoch ms.
  void EmitRecord(base::StringView value) {
    std::optional<int64_t> epoch_ms = base::StringViewToInt64(value);
    if (!epoch_ms || *epoch_ms <= 0)
      return;
    int64_t tz_ms =
        deps_.context->clock_tracker->timezone_offset().value_or(0) /
        (1000 * 1000);
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Notifications";
    event.name = pkg_;
    event.args.emplace_back("list", list_);
    if (!channel_.empty())
      event.args.emplace_back("channel", channel_);
    if (!id_.empty())
      event.args.emplace_back("id", id_);
    if (!tag_.empty() && tag_ != "null")
      event.args.emplace_back("tag", tag_);
    if (!uid_.empty())
      event.args.emplace_back("uid", uid_);
    deps_.emitter->Emit(*epoch_ms + tz_ms, std::move(event));
  }

  static base::StringView TrimLeft(base::StringView sv) {
    size_t i = 0;
    while (i < sv.size() && sv.at(i) == ' ')
      ++i;
    return sv.substr(i);
  }

  const BugreportParserDeps deps_;
  std::string list_ = "posted";
  bool has_record_ = false;
  std::string pkg_;
  std::string id_;
  std::string tag_;
  std::string channel_;
  std::string uid_;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysNotificationParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysNotificationParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
