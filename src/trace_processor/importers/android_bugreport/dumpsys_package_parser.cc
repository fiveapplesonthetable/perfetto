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

// Parses the "Packages:" blocks of "DUMP OF SERVICE package:", as printed by
// Settings.dumpPackageLPr on SDK 36 (Baklava, BP4A.251205.006):
//
//   Packages:
//     Package [com.android.calendar] (e07b3c5):
//       appId=10103
//       ...
//       versionCode=36 minSdk=36 targetSdk=36
//       versionName=16
//       ...
//       lastUpdateTime=2026-06-10 09:02:03
//       ...
//       User 0: ceDataInode=... installed=true ...
//         firstInstallTime=2026-06-10 09:02:03
//
// Timestamps are formatted with SimpleDateFormat("yyyy-MM-dd HH:mm:ss") in
// the device-local timezone, i.e. directly the wall-clock ms the emitter
// expects. Each per-user firstInstallTime becomes a kInstant on the
// "Package installs" track named after the package; when the package-level
// lastUpdateTime differs from firstInstallTime (i.e. the package was updated
// after the initial install) one more kInstant is emitted on the
// "Package updates" track at the update time.
//
// This dump is by far the largest dumpsys section (tens of thousands of
// lines), so this parser is deliberately a minimal line scanner: every line
// is dispatched on a cheap fixed-indent prefix check and everything outside
// the four matched prefixes is ignored (permissions, signatures, overlay
// paths, shared users, etc.). "timeStamp=" (apk mtime, often epoch 0) is
// deliberately not parsed.
class DumpsysPackageParser : public BugreportSectionParser {
 public:
  explicit DumpsysPackageParser(const BugreportParserDeps& deps)
      : deps_(deps) {}

  base::Status ParseLine(base::StringView line) override {
    // "  Package [com.android.calendar] (e07b3c5):".
    if (line.StartsWith("  Package [")) {
      size_t end = line.find(']', 11);
      package_ = end == base::StringView::npos
                     ? ""
                     : line.substr(11, end - 11).ToStdString();
      version_.clear();
      last_update_raw_.clear();
      last_update_ms_.reset();
      update_emitted_ = false;
      return base::OkStatus();
    }
    if (package_.empty()) {
      return base::OkStatus();
    }
    if (line.StartsWith("    versionName=")) {
      version_ = line.substr(16).ToStdString();
      return base::OkStatus();
    }
    if (line.StartsWith("    lastUpdateTime=")) {
      last_update_raw_ = line.substr(19).ToStdString();
      last_update_ms_ = ParseIsoDateTimeMs(line.substr(19));
      return base::OkStatus();
    }
    if (line.StartsWith("      firstInstallTime=")) {
      EmitInstall(line.substr(23));
    }
    return base::OkStatus();
  }

 private:
  void EmitInstall(base::StringView value) {
    std::optional<int64_t> install_ms = ParseIsoDateTimeMs(value);
    if (!install_ms) {
      return;
    }
    BugreportTimelineEvent event;
    event.kind = BugreportTimelineEvent::Kind::kInstant;
    event.track = "Package installs";
    event.name = package_;
    if (!version_.empty()) {
      event.args.emplace_back("version", version_);
    }
    if (!last_update_raw_.empty()) {
      event.args.emplace_back("lastUpdateTime", last_update_raw_);
    }
    deps_.emitter->Emit(*install_ms, std::move(event));

    // The package was updated after its initial install: one extra instant
    // at the update time (only once per package; with multiple users the
    // per-user firstInstallTime lines repeat but lastUpdateTime does not).
    if (update_emitted_ || !last_update_ms_ ||
        *last_update_ms_ == *install_ms) {
      return;
    }
    update_emitted_ = true;
    BugreportTimelineEvent update;
    update.kind = BugreportTimelineEvent::Kind::kInstant;
    update.track = "Package updates";
    update.name = package_;
    if (!version_.empty()) {
      update.args.emplace_back("version", version_);
    }
    deps_.emitter->Emit(*last_update_ms_, std::move(update));
  }

  const BugreportParserDeps deps_;
  std::string package_;
  std::string version_;
  std::string last_update_raw_;
  std::optional<int64_t> last_update_ms_;
  bool update_emitted_ = false;
};

}  // namespace

std::unique_ptr<BugreportSectionParser> CreateDumpsysPackageParser(
    const BugreportParserDeps& deps) {
  return std::make_unique<DumpsysPackageParser>(deps);
}

}  // namespace perfetto::trace_processor::android_bugreport
