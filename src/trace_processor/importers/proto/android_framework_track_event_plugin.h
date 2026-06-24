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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_FRAMEWORK_TRACK_EVENT_PLUGIN_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_FRAMEWORK_TRACK_EVENT_PLUGIN_H_

#include "perfetto/ext/base/flat_hash_map.h"
#include "perfetto/protozero/field.h"
#include "src/trace_processor/importers/proto/track_event_plugin.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/tables/android_tables_py.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

// Records the frameworks/base AndroidProcessStartEvent / AndroidBinderDiedEvent
// TrackEvent extensions into __intrinsic_android_track_event_process
// (upid, fw_start_ts, fw_end_ts). Both events are emitted as instant
// TrackEvents, so they arrive via OnTrackEventSliceExtension.
class AndroidFrameworkTrackEventPlugin : public TrackEventPlugin {
 public:
  AndroidFrameworkTrackEventPlugin(TrackEventPluginContext* plugin_context,
                                   TraceProcessorContext* context);
  ~AndroidFrameworkTrackEventPlugin() override;

  Result OnTrackEventSliceExtension(const TrackEventExtensionField& field,
                                    SliceId id) override;

 private:
  void SetProcessMetadata(UniquePid upid, protozero::ConstBytes process_start);
  tables::AndroidTrackEventProcessTable::RowReference GetOrInsertRow(
      UniquePid upid);
  void HandleProcessStart(protozero::ConstBytes data, int64_t ts);
  void HandleBinderDied(protozero::ConstBytes data, int64_t ts);

  // Named to avoid shadowing TrackEventPlugin::context_ (the plugin registry
  // context); this is the trace-wide context (process tracker, storage).
  TraceProcessorContext* tp_context_;
  base::FlatHashMap<UniquePid, tables::AndroidTrackEventProcessTable::Id>
      upid_to_row_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_FRAMEWORK_TRACK_EVENT_PLUGIN_H_
