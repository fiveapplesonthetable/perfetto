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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_METHOD_TRACE_MODULE_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_METHOD_TRACE_MODULE_H_

#include <cstdint>

#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/common/parser_types.h"
#include "src/trace_processor/importers/proto/proto_importer_module.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor {

// Decodes ArtMethodTraceLongRunning trace packets emitted by the
// "android.art.method_trace" data source (art/perfetto_method_trace) into
// per-thread method-call slices.
//
// The packet payload is a 32-byte "SLOW" header followed by the V2
// long-running stream produced by art::TraceProfiler::DumpData:
//   * kEntryHeaderV2 (= 2) chunks: 1B header + 4B tid + 3B num_records +
//       4B size + SLEB128(time_action_diff) +
//       [SLEB128(method_diff) on method-enter only].
//   * kThreadInfoHeaderV2 (= 0): 1B + 4B tid + 2B name_len + name.
//   * kMethodInfoHeaderV2 (= 1): 1B + 8B method_ptr + 2B info_len + info.
//
// Each method-enter event becomes a slice begin and each method-exit becomes
// a slice end on the corresponding thread track. Method labels are formatted
// as "ClassName.method:signature".
class ArtMethodTraceModule : public ProtoImporterModule {
 public:
  explicit ArtMethodTraceModule(ProtoImporterModuleContext* module_context,
                                TraceProcessorContext* context);

  ~ArtMethodTraceModule() override;

  void ParseTracePacketData(const protos::pbzero::TracePacket::Decoder& decoder,
                            int64_t ts,
                            const TracePacketData&,
                            uint32_t field_id) override;

 private:
  TraceProcessorContext* context_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_METHOD_TRACE_MODULE_H_
