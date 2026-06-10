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

#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"

#include <cstdint>
#include <optional>
#include <utility>

#include "perfetto/ext/base/string_view.h"
#include "protos/perfetto/trace/clock_snapshot.pbzero.h"
#include "src/trace_processor/importers/common/clock_tracker.h"
#include "src/trace_processor/importers/common/event_tracker.h"
#include "src/trace_processor/importers/common/slice_tracker.h"
#include "src/trace_processor/importers/common/track_compressor.h"
#include "src/trace_processor/importers/common/track_tracker.h"
#include "src/trace_processor/importers/common/tracks.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor::android_bugreport {

namespace {

// The track type ("android_bugreport") drives the grouping of these tracks
// under a "Bugreport" group in the UI, see
// ui/src/plugins/dev.perfetto.TraceProcessorTrack/slice_tracks.ts.
constexpr auto kSliceBlueprint = TrackCompressor::SliceBlueprint(
    "android_bugreport",
    tracks::DimensionBlueprints(
        tracks::StringDimensionBlueprint("bugreport_track")),
    tracks::FnNameBlueprint([](base::StringView track) {
      return base::StackString<256>("%.*s", int(track.size()), track.data());
    }));

constexpr auto kCounterBlueprint = tracks::CounterBlueprint(
    "android_bugreport_counter",
    tracks::UnknownUnitBlueprint(),
    tracks::Dimensions(tracks::StringDimensionBlueprint("bugreport_track")),
    tracks::FnNameBlueprint([](base::StringView track) {
      return base::StackString<256>("%.*s", int(track.size()), track.data());
    }));

}  // namespace

BugreportTimelineEventParser::~BugreportTimelineEventParser() = default;

void BugreportTimelineEventParser::Parse(int64_t ts,
                                         BugreportTimelineEvent event) {
  if (event.kind == BugreportTimelineEvent::Kind::kCounter) {
    TrackId track = context_->track_tracker->InternTrack(
        kCounterBlueprint, tracks::Dimensions(base::StringView(event.track)));
    context_->event_tracker->PushCounter(ts, event.counter_value, track);
    return;
  }

  int64_t dur =
      event.kind == BugreportTimelineEvent::Kind::kSlice ? event.dur_ns : 0;
  TrackId track = context_->track_compressor->InternScoped(
      kSliceBlueprint, tracks::Dimensions(base::StringView(event.track)), ts,
      dur);
  StringId name_id =
      context_->storage->InternString(base::StringView(event.name));
  auto args_fn = [&](ArgsTracker::BoundInserter* inserter) {
    for (const auto& kv : event.args) {
      inserter->AddArg(
          context_->storage->InternString(base::StringView(kv.first)),
          Variadic::String(
              context_->storage->InternString(base::StringView(kv.second))));
    }
  };
  context_->slice_tracker->Scoped(
      ts, track, kNullStringId, name_id, dur,
      event.args.empty() ? SliceTracker::SetArgsCallback() : args_fn);
}

BugreportTimelineEmitter::BugreportTimelineEmitter(
    TraceProcessorContext* context,
    const BugreportFormat* format)
    : context_(context),
      format_(format),
      stream_(context->sorter->CreateStream(
          std::make_unique<BugreportTimelineEventParser>(context))) {}

BugreportTimelineEmitter::~BugreportTimelineEmitter() = default;

void BugreportTimelineEmitter::Emit(int64_t wall_ms,
                                    BugreportTimelineEvent event) {
  if (!context_->clock_tracker->timezone_offset().has_value()) {
    buffered_.emplace_back(wall_ms, std::move(event));
    return;
  }
  Flush();
  SendToSorter(wall_ms, std::move(event));
}

void BugreportTimelineEmitter::EmitAtElapsed(int64_t elapsed_ms,
                                             BugreportTimelineEvent event) {
  buffered_elapsed_.emplace_back(elapsed_ms, std::move(event));
}

void BugreportTimelineEmitter::Flush() {
  for (auto& it : buffered_) {
    SendToSorter(it.first, std::move(it.second));
  }
  buffered_.clear();
  if (format_->anchor_wall_ms.has_value()) {
    for (auto& it : buffered_elapsed_) {
      std::optional<int64_t> wall_ms = format_->ElapsedToWallMs(it.first);
      if (wall_ms) {
        SendToSorter(*wall_ms, std::move(it.second));
      }
    }
    buffered_elapsed_.clear();
  }
}

void BugreportTimelineEmitter::SendToSorter(int64_t wall_ms,
                                            BugreportTimelineEvent event) {
  // Dumps print epoch-0 placeholders for never-happened timestamps (e.g. a
  // sticky broadcast's enqueueClockTime=1970-01-01). A single such event
  // would stretch the trace bounds back to 1970, squashing all real data
  // into the right edge of the timeline; drop anything before 2000-01-01.
  constexpr int64_t kMinSaneWallMs = 946684800000;  // 2000-01-01.
  if (wall_ms < kMinSaneWallMs) {
    return;
  }
  int64_t ts = wall_ms * 1000 * 1000 -
               context_->clock_tracker->timezone_offset().value_or(0);
  std::optional<int64_t> trace_ts = context_->clock_tracker->ToTraceTime(
      ClockTracker::ClockId::Machine(
          protos::pbzero::ClockSnapshot::Clock::REALTIME),
      ts);
  if (trace_ts) {
    stream_->Push(*trace_ts, std::move(event));
  }
}

}  // namespace perfetto::trace_processor::android_bugreport
