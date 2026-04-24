/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

#include "src/trace_processor/importers/proto/android_binder_parcel_module.h"

#include <cinttypes>
#include <cstdint>
#include <string>

#include "perfetto/ext/base/string_utils.h"
#include "perfetto/protozero/field.h"
#include "src/trace_processor/importers/common/args_tracker.h"
#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/importers/common/slice_tracker.h"
#include "src/trace_processor/importers/common/track_tracker.h"
#include "src/trace_processor/storage/trace_storage.h"

#include "protos/perfetto/trace/android/android_binder_parcel.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"

namespace perfetto::trace_processor {

using perfetto::protos::pbzero::AndroidBinderParcelEvent;
using perfetto::protos::pbzero::ParcelFieldAnnotation;
using perfetto::protos::pbzero::TracePacket;

namespace {

const char* DirectionToString(int32_t dir) {
    switch (dir) {
        case AndroidBinderParcelEvent::CLIENT_SEND: return "CLIENT_SEND";
        case AndroidBinderParcelEvent::SERVER_RECV: return "SERVER_RECV";
        case AndroidBinderParcelEvent::SERVER_REPLY: return "SERVER_REPLY";
        case AndroidBinderParcelEvent::CLIENT_RECV: return "CLIENT_RECV";
        default: return "UNKNOWN";
    }
}

const char* KindToString(int32_t kind) {
    switch (kind) {
        case AndroidBinderParcelEvent::PRIMITIVE: return "primitive";
        case AndroidBinderParcelEvent::STRING: return "string";
        case AndroidBinderParcelEvent::STRONG_BINDER: return "strong_binder";
        case AndroidBinderParcelEvent::FILE_DESCRIPTOR: return "file_descriptor";
        case AndroidBinderParcelEvent::PARCELABLE: return "parcelable";
        case AndroidBinderParcelEvent::TYPED_OBJECT: return "typed_object";
        case AndroidBinderParcelEvent::ARRAY: return "array";
        case AndroidBinderParcelEvent::VECTOR: return "vector";
        case AndroidBinderParcelEvent::BYTES: return "bytes";
        case AndroidBinderParcelEvent::INTERFACE_TOKEN: return "interface_token";
        case AndroidBinderParcelEvent::OPAQUE: return "opaque";
        default: return "unspecified";
    }
}

}  // namespace

AndroidBinderParcelModule::AndroidBinderParcelModule(
        ProtoImporterModuleContext* module_context, TraceProcessorContext* context)
    : ProtoImporterModule(module_context), context_(context) {
    RegisterForField(TracePacket::kAndroidBinderParcelFieldNumber);
}

void AndroidBinderParcelModule::ParseTracePacketData(
        const TracePacket::Decoder& decoder, int64_t ts, const TracePacketData&,
        uint32_t field_id) {
    if (field_id != TracePacket::kAndroidBinderParcelFieldNumber) return;
    ParseAndroidBinderParcel(ts, decoder.android_binder_parcel());
}

void AndroidBinderParcelModule::ParseAndroidBinderParcel(int64_t ts,
                                                         protozero::ConstBytes blob) {
    AndroidBinderParcelEvent::Decoder ev(blob);

    // One slice per AIDL transaction half, always named "parcel". The
    // interface name and method live in args so the user can filter on
    // them, but visually every binder transaction is a "parcel" slice.
    uint32_t pid = static_cast<uint32_t>(ev.pid());
    uint32_t tid = static_cast<uint32_t>(ev.tid());
    UniqueTid utid = context_->process_tracker->UpdateThread(tid, pid);
    TrackId track_id = context_->track_tracker->InternThreadTrack(utid);

    StringId cat_id = context_->storage->InternString("aidl");
    StringId name_id = context_->storage->InternString("parcel");
    // Instant: zero duration. The same logical RPC has up to four halves
    // (CLIENT_SEND/SERVER_RECV/SERVER_REPLY/CLIENT_RECV) — each is its
    // own instant slice on its respective thread, joined by binder.txn_id.
    int64_t dur = 0;

    context_->slice_tracker->Scoped(
            ts, track_id, cat_id, name_id, dur,
            [this, &ev](ArgsTracker::BoundInserter* inserter) {
                auto* storage = context_->storage.get();

                auto add_str_at = [&](const std::string& k, protozero::ConstChars v) {
                    if (v.size == 0) return;
                    inserter->AddArg(storage->InternString(base::StringView(k)),
                                     Variadic::String(storage->InternString(v)));
                };
                auto add_str_lit = [&](const std::string& k, const char* v) {
                    inserter->AddArg(storage->InternString(base::StringView(k)),
                                     Variadic::String(storage->InternString(
                                             protozero::ConstChars{v, std::strlen(v)})));
                };
                auto add_uint = [&](const std::string& k, uint64_t v) {
                    inserter->AddArg(storage->InternString(base::StringView(k)),
                                     Variadic::UnsignedInteger(v));
                };
                auto add_int = [&](const std::string& k, int64_t v) {
                    inserter->AddArg(storage->InternString(base::StringView(k)),
                                     Variadic::Integer(v));
                };
                auto add_bool = [&](const std::string& k) {
                    inserter->AddArg(storage->InternString(base::StringView(k)),
                                     Variadic::Boolean(true));
                };

                // Transaction-level args.
                add_str_at("binder.interface", ev.interface_name());
                if (ev.method_name().size > 0) {
                    add_str_at("binder.method", ev.method_name());
                } else {
                    add_uint("binder.method_code", ev.code());
                }
                add_uint("binder.code", ev.code());
                add_uint("binder.flags", ev.flags());
                add_str_lit("binder.direction", DirectionToString(ev.direction()));
                add_uint("binder.txn_id", ev.txn_id());
                add_int("binder.returned_status", ev.returned_status());
                if (ev.has_oneway() && ev.oneway()) add_bool("binder.oneway");
                add_str_at("binder.thread_name", ev.thread_name());

                if (ev.has_metadata()) {
                    AndroidBinderParcelEvent::ParcelMetadata::Decoder md(ev.metadata());
                    auto md_uint = [&](const char* k, bool has, uint64_t v) {
                        if (has && v > 0) add_uint(k, v);
                    };
                    md_uint("binder.data_size_bytes",
                            md.has_total_data_size(), md.total_data_size());
                    md_uint("binder.object_count",
                            md.has_object_count(), md.object_count());
                    md_uint("binder.binder_count",
                            md.has_binder_count(), md.binder_count());
                    md_uint("binder.fd_count",
                            md.has_file_descriptor_count(), md.file_descriptor_count());
                    md_uint("binder.fd_array_count",
                            md.has_file_descriptor_array_count(),
                            md.file_descriptor_array_count());
                    md_uint("binder.pointer_count",
                            md.has_pointer_count(), md.pointer_count());
                    md_uint("binder.shared_memory_bytes",
                            md.has_shared_memory_bytes(), md.shared_memory_bytes());
                    if (md.has_sensitive() && md.sensitive()) add_bool("binder.sensitive");
                    if (md.has_is_rpc() && md.is_rpc()) add_bool("binder.is_rpc");
                    if (md.has_strict_mode_policy()) {
                        add_uint("binder.strict_mode_policy", md.strict_mode_policy());
                    }
                    if (md.has_work_source_uid()) {
                        add_int("binder.work_source_uid", md.work_source_uid());
                    }
                }

                // Recursive walker: emits one set of args per node and
                // recurses into ParcelFieldAnnotation.nested children.
                //
                // Path scheme:
                //   - PARCELABLE child:  parent_path + "." + field_name
                //   - VECTOR/ARRAY elem: parent_path + "[" + index + "]"
                //                        (the proto carries field_name
                //                         "_aidl_element[N]" already, so
                //                         we honor it verbatim)
                //   - top-level:         "binder." + field_name
                //
                // Per node we emit:
                //   <path>                = aidl_type             (string)
                //   <path>.kind           = PRIMITIVE/STRING/...  (string)
                //   <path>.value          = decoded preview       (typed)
                //   <path>.byte_length    = bytes on wire         (uint)
                //   <path>.is_null        = true                  (bool, conditional)
                //   <path>.nullable       = true                  (bool, conditional)
                //   <path>.element_count  = vec/array size        (uint, conditional)
                //   <path>.descriptor     = binder iface name     (string, STRONG_BINDER)
                //   <path>.fd_size_bytes  = stat size             (uint, FILE_DESCRIPTOR)
                //   <path>.fd_kind        = ashmem/regular/...    (string, FILE_DESCRIPTOR)
                //   <path>.sensitive      = true                  (bool, conditional)
                //
                // Perfetto's UI groups args sharing a common dotted
                // prefix into a tree, so the user sees the full
                // parcelable hierarchy expanded by clicking the slice.
                // Iterative (LIFO) walker. Recursion would blow the WASM
                // stack (~64 KB) on deeply-nested parcels — std::function +
                // std::string copy at each frame is ~1 KB, so >60 levels
                // crashes the trace_processor in the Perfetto UI even
                // though it works fine in the host binary (~8 MB stack).
                // The explicit work-stack here is heap-allocated and bounded
                // only by available memory.
                struct Frame {
                    protozero::ConstBytes blob;
                    std::string parent_path;
                    bool parent_is_seq;
                };
                std::vector<Frame> work;
                for (auto it = ev.annotation(); it; ++it) {
                    work.push_back({*it, std::string(), false});
                }
                // Process FIFO so siblings appear before children — but
                // either order works since args are unordered in storage.
                while (!work.empty()) {
                    Frame f = std::move(work.back());
                    work.pop_back();
                    ParcelFieldAnnotation::Decoder a(f.blob);

                    std::string path = f.parent_path;
                    if (a.field_name().size > 0) {
                        std::string fn(a.field_name().data, a.field_name().size);
                        if (f.parent_is_seq && !fn.empty() && fn[0] == '[') {
                            path += fn;
                        } else if (f.parent_is_seq &&
                                   fn.rfind("_aidl_element", 0) == 0) {
                            path += fn.substr(std::strlen("_aidl_element"));
                        } else if (!f.parent_path.empty()) {
                            path += "." + fn;
                        } else {
                            path = "binder." + fn;
                        }
                    } else if (f.parent_path.empty()) {
                        path = "binder.arg";
                    }

                    if (a.aidl_type().size > 0) {
                        add_str_at(path, a.aidl_type());
                    }
                    if (a.has_int_preview()) {
                        add_int(path + ".value", a.int_preview());
                    } else if (a.has_double_preview()) {
                        inserter->AddArg(
                                storage->InternString(base::StringView(path + ".value")),
                                Variadic::Real(a.double_preview()));
                    } else if (a.has_string_preview()) {
                        add_str_at(path + ".value", a.string_preview());
                    } else if (a.has_binder_descriptor_preview()) {
                        add_str_at(path + ".descriptor", a.binder_descriptor_preview());
                    } else if (a.has_bytes_preview()) {
                        protozero::ConstBytes bp = a.bytes_preview();
                        add_str_at(path + ".value",
                                   protozero::ConstChars{
                                           reinterpret_cast<const char*>(bp.data), bp.size});
                    }

                    if (a.kind()) {
                        add_str_lit(path + ".kind", KindToString(a.kind()));
                    }
                    if (a.byte_length()) {
                        add_uint(path + ".byte_length", a.byte_length());
                    }
                    if (a.has_nullable() && a.nullable()) {
                        add_bool(path + ".nullable");
                    }
                    if (a.has_is_null() && a.is_null()) {
                        add_bool(path + ".is_null");
                    }
                    if (a.has_is_empty() && a.is_empty()) {
                        add_bool(path + ".is_empty");
                    }
                    if (a.has_element_count() && a.element_count() > 0) {
                        add_uint(path + ".element_count", a.element_count());
                    }
                    if (a.has_fd_size_bytes()) {
                        add_uint(path + ".fd_size_bytes", a.fd_size_bytes());
                    }
                    if (a.has_fd_kind()) {
                        add_str_at(path + ".fd_kind", a.fd_kind());
                    }
                    if (a.has_sensitive() && a.sensitive()) {
                        add_bool(path + ".sensitive");
                    }

                    bool this_is_seq =
                            (a.kind() == AndroidBinderParcelEvent::VECTOR ||
                             a.kind() == AndroidBinderParcelEvent::ARRAY);
                    for (auto cit = a.nested(); cit; ++cit) {
                        work.push_back({*cit, path, this_is_seq});
                    }
                }
            });
}

}  // namespace perfetto::trace_processor
