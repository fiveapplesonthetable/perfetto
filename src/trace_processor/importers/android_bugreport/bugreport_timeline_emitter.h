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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EMITTER_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EMITTER_H_

#include <chrono>
#include <cstdint>
#include <memory>
#include <vector>

#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_event.h"
#include "src/trace_processor/sorter/trace_sorter.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

namespace android_bugreport {

// Sorter sink that materializes BugreportTimelineEvents into the slice /
// counter tables on "bugreport: <track>" global tracks.
class BugreportTimelineEventParser
    : public TraceSorter::Sink<BugreportTimelineEvent,
                               BugreportTimelineEventParser> {
 public:
  explicit BugreportTimelineEventParser(TraceProcessorContext* context)
      : context_(context) {}
  ~BugreportTimelineEventParser() override;

  void Parse(int64_t ts, BugreportTimelineEvent event);

 private:
  TraceProcessorContext* const context_;
};

// Shared by all bugreport section parsers to push timeline events.
//
// Timestamps in bugreports are wall-clock in the device's local timezone; the
// timezone offset only becomes known midway through parsing (from the alarm
// service dump). Events emitted before that are buffered and flushed once the
// offset is known, mirroring AndroidLogReader's wait_for_tz behavior.
class BugreportTimelineEmitter {
 public:
  BugreportTimelineEmitter(TraceProcessorContext* context,
                           const BugreportFormat* format);
  ~BugreportTimelineEmitter();

  // `wall_ms` is wall-clock ms since epoch in the device local timezone.
  void Emit(int64_t wall_ms, BugreportTimelineEvent event);

  // For events whose timestamp is based on elapsedRealtime (ms since boot).
  // They are buffered until the elapsed <-> wall anchor is discovered (from
  // the alarm service dump, see BugreportFormat::ElapsedToWallMs) and
  // dropped at end of file if it never is.
  void EmitAtElapsed(int64_t elapsed_ms, BugreportTimelineEvent event);

  // Flushes buffered events (called at end of the dumpstate file, regardless
  // of whether a timezone offset was ever found).
  void Flush();

 private:
  void SendToSorter(int64_t wall_ms, BugreportTimelineEvent event);

  TraceProcessorContext* const context_;
  const BugreportFormat* const format_;
  std::unique_ptr<TraceSorter::Stream<BugreportTimelineEvent>> stream_;
  std::vector<std::pair<int64_t, BugreportTimelineEvent>> buffered_;
  std::vector<std::pair<int64_t, BugreportTimelineEvent>> buffered_elapsed_;
};

}  // namespace android_bugreport
}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_TIMELINE_EMITTER_H_
