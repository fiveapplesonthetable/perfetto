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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_FORMAT_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_FORMAT_H_

#include <cstdint>
#include <optional>
#include <string>

#include "perfetto/ext/base/string_view.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

namespace android_bugreport {

// Device / format information parsed from the preamble of the
// bugreport-xxx.txt file (everything before the first "------ SECTION ------"
// marker), e.g.:
//
//   ========================================================
//   == dumpstate: 2026-06-10 09:21:16
//   ========================================================
//
//   Build: aosp_cf_x86_64_phone-userdebug Baklava BP4A.251205.006 ...
//   Build fingerprint: 'generic/aosp_cf_x86_64_phone/vsoc_x86_64:Baklava/...'
//   ...
//   Android SDK version: 36
//
// Section parsers receive this so they can adapt to per-release format
// changes: when a service's dump format drifts in SDK N, gate the new parsing
// path on `sdk_version >= N` (see BugreportParserRegistry).
struct BugreportFormat {
  // Wall-clock time at which dumpstate started, in ms since the epoch, as
  // printed in the device's local timezone. The timezone offset is discovered
  // later (from the alarm service dump) via ClockTracker::timezone_offset().
  std::optional<int64_t> dumpstate_start_ms;

  // "Android SDK version: 36". 0 if not found.
  int32_t sdk_version = 0;

  // "Build: aosp_cf_x86_64_phone-userdebug Baklava BP4A.251205.006 ...".
  std::string build;

  // "Build fingerprint: '...'" without the quotes.
  std::string build_fingerprint;

  // An exact elapsedRealtime <-> wall-clock anchor, parsed from the alarm
  // service's "nowRTC=<ms>=<local iso> nowELAPSED=<ms>" line (the same line
  // that provides the timezone offset). When set, timestamps based on
  // elapsedRealtime can be converted to (local) wall-clock ms via
  // elapsed_ms + (anchor_wall_ms - anchor_elapsed_ms).
  std::optional<int64_t> anchor_wall_ms;
  std::optional<int64_t> anchor_elapsed_ms;

  // Converts an elapsedRealtime-based timestamp to local wall-clock ms, if
  // the anchor is known.
  std::optional<int64_t> ElapsedToWallMs(int64_t elapsed_ms) const {
    if (!anchor_wall_ms || !anchor_elapsed_ms) {
      return std::nullopt;
    }
    return elapsed_ms + (*anchor_wall_ms - *anchor_elapsed_ms);
  }
};

// Incrementally populates a BugreportFormat from preamble lines and, on
// completion, records the parsed values in the metadata table.
class BugreportFormatParser {
 public:
  explicit BugreportFormatParser(TraceProcessorContext* context);

  // Feed one preamble line. Returns true if the line was recognized.
  bool ParseLine(base::StringView line);

  // Called when the preamble is over (first section marker seen). Writes
  // metadata entries.
  void Finalize();

  // Records the elapsedRealtime <-> wall-clock anchor discovered mid-file
  // (from the alarm service dump).
  void SetElapsedAnchor(int64_t wall_ms, int64_t elapsed_ms) {
    format_.anchor_wall_ms = wall_ms;
    format_.anchor_elapsed_ms = elapsed_ms;
  }

  const BugreportFormat& format() const { return format_; }

 private:
  TraceProcessorContext* const context_;
  BugreportFormat format_;
};

}  // namespace android_bugreport
}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_FORMAT_H_
