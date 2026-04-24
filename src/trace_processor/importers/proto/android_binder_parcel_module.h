/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_BINDER_PARCEL_MODULE_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_BINDER_PARCEL_MODULE_H_

#include <cstdint>

#include "perfetto/protozero/field.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/common/parser_types.h"
#include "src/trace_processor/importers/proto/proto_importer_module.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor {

// Parses AndroidBinderParcelEvent TracePackets into:
//   - A slice on the "AIDL Binder" thread track with name
//     "<interface>::<method>"
//   - One arg per ParcelFieldAnnotation with key
//     "binder.<field_name>" and a typed value selected from the
//     preview variant (int, double, string, bytes).
//   - A set of top-level args for metadata:
//     "binder.interface_name", "binder.code", "binder.direction",
//     "binder.txn_id", "binder.data_size_bytes", "binder.binder_count",
//     "binder.fd_count", "binder.shared_memory_bytes", etc.
//   - flow_id = txn_id so the UI renders arrows between the four
//     halves of each logical RPC.
class AndroidBinderParcelModule : public ProtoImporterModule {
 public:
  explicit AndroidBinderParcelModule(ProtoImporterModuleContext* module_context,
                                     TraceProcessorContext* context);
  ~AndroidBinderParcelModule() override = default;

  void ParseTracePacketData(const protos::pbzero::TracePacket::Decoder& decoder,
                            int64_t ts,
                            const TracePacketData&,
                            uint32_t field_id) override;

 private:
  void ParseAndroidBinderParcel(int64_t ts, protozero::ConstBytes blob);

  TraceProcessorContext* const context_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_ANDROID_BINDER_PARCEL_MODULE_H_
