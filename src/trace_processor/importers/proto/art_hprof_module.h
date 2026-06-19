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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_HPROF_MODULE_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_HPROF_MODULE_H_

#include <cstdint>

#include "src/trace_processor/importers/art_hprof/art_hprof_parser.h"
#include "src/trace_processor/importers/common/parser_types.h"
#include "src/trace_processor/importers/proto/proto_importer_module.h"

#include "protos/perfetto/trace/trace_packet.pbzero.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

// Routes an ART hprof embedded in a TracePacket (the art_hprof bytes field)
// into the same ArtHprofParser used for standalone .hprof files, so an embedded
// Java heap dump populates the heap_graph_* tables. The whole hprof is expected
// in one packet (large packets are fine; they fragment over the SMB and are
// reassembled before parsing).
class ArtHprofModule : public ProtoImporterModule {
 public:
  ArtHprofModule(ProtoImporterModuleContext* module_context,
                 TraceProcessorContext* context);
  ~ArtHprofModule() override;

  void ParseField(const ParseFieldArgs& args) override;

  void OnEventsFullyExtracted() override;

 private:
  art_hprof::ArtHprofParser parser_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ART_HPROF_MODULE_H_
