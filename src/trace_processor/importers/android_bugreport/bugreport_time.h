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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIME_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIME_H_

#include <cstdint>
#include <optional>

#include "perfetto/ext/base/string_view.h"

// Time-format parsing helpers for Android bugreports.
//
// Android system services print timestamps in a small zoo of formats. All the
// parsers for those formats live here, in one place, so that when a format
// drifts between Android releases the fix is local to this file (and its
// unittest).

namespace perfetto::trace_processor::android_bugreport {

// Parses "2026-06-10 09:21:16" or "2026-06-10 09:21:16.123" into wall-clock
// milliseconds (interpreting the date as UTC; the caller is responsible for
// applying the device timezone offset, see ClockTracker::timezone_offset()).
std::optional<int64_t> ParseIsoDateTimeMs(base::StringView sv);

// Parses a duration as printed by android.util.TimeUtils.formatDuration():
//   "+1d0h3m4s5ms", "-1h2m3s4ms", "+5s0ms", "+41ms", "-41ms", "0"
// Returns the (signed) duration in milliseconds.
std::optional<int64_t> ParseAndroidDurationMs(base::StringView sv);

}  // namespace perfetto::trace_processor::android_bugreport

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIME_H_
