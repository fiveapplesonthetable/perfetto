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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EVENT_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EVENT_H_

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace perfetto::trace_processor::android_bugreport {

// A generic timeline event extracted from a bugreport section by one of the
// section parsers (see BugreportSectionParser). Events are pushed through the
// trace sorter and materialized as slices / instants / counters on global
// async tracks named "bugreport: <track>".
struct BugreportTimelineEvent {
  enum class Kind { kInstant, kSlice, kCounter };

  Kind kind = Kind::kInstant;

  // Track name, e.g. "Broadcasts (foreground)", "Job history".
  std::string track;

  // Slice/instant name. Unused for counters.
  std::string name;

  // Only for kSlice: duration in ns (0 renders as instant-like slice).
  int64_t dur_ns = 0;

  // Only for kCounter.
  double counter_value = 0;

  // Extra details surfaced as args on the slice (key, value string pairs).
  std::vector<std::pair<std::string, std::string>> args;
};

}  // namespace perfetto::trace_processor::android_bugreport

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EVENT_H_
