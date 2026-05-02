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

#include "src/trace_processor/importers/proto/art_method_trace_module.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "perfetto/base/logging.h"
#include "perfetto/ext/base/string_utils.h"
#include "perfetto/protozero/field.h"
#include "protos/perfetto/trace/android/art_method_trace.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/importers/common/slice_tracker.h"
#include "src/trace_processor/importers/common/track_tracker.h"
#include "src/trace_processor/storage/trace_storage.h"

namespace perfetto::trace_processor {

namespace {

// Wire constants kept in sync with art/runtime/trace.h and
// art/perfetto_method_trace/perfetto_method_trace.cc.
constexpr uint32_t kTraceMagic = 0x574f4c53;  // 'SLOW'
constexpr size_t kSlowHeaderLength = 32;
constexpr uint16_t kStreamingFlag = 0xF0;
constexpr uint16_t kVersionLongRunningV2 = 6;

constexpr uint8_t kThreadInfoHeaderV2 = 0;
constexpr uint8_t kMethodInfoHeaderV2 = 1;
constexpr uint8_t kEntryHeaderV2 = 2;
// Newer ART builds prepend a 17-byte summary record (1B type + 16B fixed
// payload, two uint64 timestamps) between the SLOW header and the first
// kEntryHeaderV2 chunk. We skip its content; the chunks contain everything
// the importer needs.
constexpr uint8_t kSummaryHeaderV2 = 3;

constexpr size_t kEntryChunkHeaderSize = 12;
constexpr size_t kThreadInfoHeaderSize = 7;
constexpr size_t kMethodInfoHeaderSize = 11;
constexpr size_t kSummaryHeaderSizeV2 = 17;

// Reads a little-endian integer of |Bytes| bytes from |data + off|. The caller
// must have already bounds-checked.
template <size_t Bytes>
uint64_t ReadLE(const uint8_t* data, size_t off) {
  uint64_t v = 0;
  for (size_t i = 0; i < Bytes; i++) {
    v |= static_cast<uint64_t>(data[off + i]) << (i * 8);
  }
  return v;
}

// Decodes a single SLEB128 from |data[off..]|, advances |off| past it. Returns
// false on overrun or malformed input.
bool DecodeSignedLeb128(const uint8_t* data,
                        size_t end,
                        size_t* off,
                        int64_t* out) {
  int64_t result = 0;
  int shift = 0;
  uint8_t byte = 0;
  while (*off < end) {
    byte = data[(*off)++];
    result |= static_cast<int64_t>(byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) == 0) {
      // Sign-extend if this is the final byte and its sign bit is set.
      if (shift < 64 && (byte & 0x40)) {
        result |= -(static_cast<int64_t>(1) << shift);
      }
      *out = result;
      return true;
    }
    if (shift >= 64) {
      return false;
    }
  }
  return false;
}

// Splits an "ART method info line" of the form
//   "ClassDescriptor\tmethodName\tsignature\tsource.java\n"
// into a render-friendly slice name "ClassName.methodName:signature". On
// parse failure, returns the raw input minus a trailing newline.
std::string FormatMethodLine(const std::string& line) {
  std::string trimmed = line;
  if (!trimmed.empty() && trimmed.back() == '\n') {
    trimmed.pop_back();
  }
  // Tab-separated: descriptor, name, signature, source. Tolerate missing
  // trailing fields rather than failing — older profiling builds skip source.
  auto parts = base::SplitString(trimmed, "\t");
  if (parts.size() < 3) {
    return trimmed;
  }
  // Strip 'L' prefix and ';' suffix from descriptor, swap '/' for '.'.
  std::string klass = parts[0];
  if (!klass.empty() && klass.front() == 'L') {
    klass = klass.substr(1);
  }
  if (!klass.empty() && klass.back() == ';') {
    klass.pop_back();
  }
  std::replace(klass.begin(), klass.end(), '/', '.');
  return klass + "." + parts[1] + ":" + parts[2];
}

}  // namespace

ArtMethodTraceModule::ArtMethodTraceModule(
    ProtoImporterModuleContext* module_context,
    TraceProcessorContext* context)
    : ProtoImporterModule(module_context), context_(context) {
  RegisterForField(
      protos::pbzero::TracePacket::kArtMethodTraceLongRunningFieldNumber);
}

ArtMethodTraceModule::~ArtMethodTraceModule() = default;

void ArtMethodTraceModule::ParseTracePacketData(
    const protos::pbzero::TracePacket::Decoder& decoder,
    int64_t /*packet_ts*/,
    const TracePacketData&,
    uint32_t field_id) {
  if (field_id !=
      protos::pbzero::TracePacket::kArtMethodTraceLongRunningFieldNumber) {
    return;
  }

  protos::pbzero::ArtMethodTraceLongRunning::Decoder evt(
      decoder.art_method_trace_long_running());
  protozero::ConstBytes payload = evt.payload();
  const uint8_t* data = payload.data;
  const size_t size = payload.size;

  // The producer pid lives on the enclosing TracePacket as trusted_pid; use
  // it to associate every per-thread track this packet creates with the
  // emitting process so the UI groups them under one process row.
  const int64_t producer_pid =
      decoder.has_trusted_pid() ? decoder.trusted_pid() : 0;
  std::string producer_name =
      evt.has_process_name() ? evt.process_name().ToStdString() : std::string();

  if (size < kSlowHeaderLength) {
    PERFETTO_DLOG(
        "ArtMethodTraceLongRunning: payload too short (%zu < 32) — drop", size);
    return;
  }
  if (ReadLE<4>(data, 0) != kTraceMagic) {
    PERFETTO_DLOG("ArtMethodTraceLongRunning: bad magic — drop");
    return;
  }
  uint16_t version = static_cast<uint16_t>(ReadLE<2>(data, 4));
  if ((version & kStreamingFlag) != kStreamingFlag ||
      (version & ~kStreamingFlag) != kVersionLongRunningV2) {
    PERFETTO_DLOG("ArtMethodTraceLongRunning: unsupported version 0x%x — drop",
                  version);
    return;
  }
  // Bytes 6..13 are the producer's monotonic-ns at session start. We don't
  // need to add it as an offset here because the per-event timestamps in the
  // chunks are already absolute monotonic-ns (TimestampCounter::GetNanoTime).

  // First pass: build method_ptr -> slice-name and thread_id -> name maps from
  // the kThreadInfoHeaderV2 / kMethodInfoHeaderV2 records that follow the
  // entry chunks (TraceProfiler::DumpData appends them at the end).
  std::unordered_map<uint64_t, std::string> method_names;
  std::unordered_map<uint32_t, std::string> thread_names;

  size_t pos = kSlowHeaderLength;
  // We have to do two passes: the entry chunks reference method_ptrs whose
  // names live in kMethodInfoHeaderV2 records that come *after* the chunks.
  // Pass 1 — only meta records.
  while (pos < size) {
    uint8_t tag = data[pos];
    if (tag == kEntryHeaderV2) {
      // Skip past the entry chunk: header + 4B size at offset 8.
      if (pos + kEntryChunkHeaderSize > size) {
        break;
      }
      uint32_t chunk_size = static_cast<uint32_t>(ReadLE<4>(data, pos + 8));
      pos += kEntryChunkHeaderSize + chunk_size;
    } else if (tag == kThreadInfoHeaderV2) {
      if (pos + kThreadInfoHeaderSize > size) {
        break;
      }
      uint32_t tid = static_cast<uint32_t>(ReadLE<4>(data, pos + 1));
      uint16_t name_len = static_cast<uint16_t>(ReadLE<2>(data, pos + 5));
      pos += kThreadInfoHeaderSize;
      if (pos + name_len > size) {
        break;
      }
      thread_names[tid] =
          std::string(reinterpret_cast<const char*>(data + pos), name_len);
      pos += name_len;
    } else if (tag == kMethodInfoHeaderV2) {
      if (pos + kMethodInfoHeaderSize > size) {
        break;
      }
      uint64_t method_ptr = ReadLE<8>(data, pos + 1);
      uint16_t info_len = static_cast<uint16_t>(ReadLE<2>(data, pos + 9));
      pos += kMethodInfoHeaderSize;
      if (pos + info_len > size) {
        break;
      }
      std::string raw(reinterpret_cast<const char*>(data + pos), info_len);
      method_names[method_ptr] = FormatMethodLine(raw);
      pos += info_len;
    } else if (tag == kSummaryHeaderV2) {
      // Fixed-size summary record (type + 16B). Content not needed for
      // slice emission; skip past it.
      if (pos + kSummaryHeaderSizeV2 > size) {
        break;
      }
      pos += kSummaryHeaderSizeV2;
    } else {
      // Unknown tag; can't safely skip.
      PERFETTO_DLOG(
          "ArtMethodTraceLongRunning: unknown tag 0x%x at offset %zu — stop",
          tag, pos);
      break;
    }
  }

  // Pass 2 — entry chunks. Decode each chunk's SLEB-encoded events and emit
  // slices on the per-thread track.
  pos = kSlowHeaderLength;
  while (pos < size) {
    uint8_t tag = data[pos];
    if (tag != kEntryHeaderV2) {
      // Skip meta records — already processed.
      if (tag == kThreadInfoHeaderV2) {
        if (pos + kThreadInfoHeaderSize > size)
          break;
        uint16_t name_len = static_cast<uint16_t>(ReadLE<2>(data, pos + 5));
        pos += kThreadInfoHeaderSize + name_len;
      } else if (tag == kMethodInfoHeaderV2) {
        if (pos + kMethodInfoHeaderSize > size)
          break;
        uint16_t info_len = static_cast<uint16_t>(ReadLE<2>(data, pos + 9));
        pos += kMethodInfoHeaderSize + info_len;
      } else if (tag == kSummaryHeaderV2) {
        if (pos + kSummaryHeaderSizeV2 > size)
          break;
        pos += kSummaryHeaderSizeV2;
      } else {
        break;
      }
      continue;
    }

    if (pos + kEntryChunkHeaderSize > size) {
      break;
    }
    uint32_t tid = static_cast<uint32_t>(ReadLE<4>(data, pos + 1));
    uint32_t num_records = static_cast<uint32_t>(ReadLE<4>(data, pos + 5)) &
                           0x00FFFFFFu;  // 3-byte field
    uint32_t chunk_size = static_cast<uint32_t>(ReadLE<4>(data, pos + 8));

    // Associate this thread with the producer process so the UI groups
    // tracks per-process. UpdateThread(tid, pid) creates / merges a thread
    // under the given pid; falling back to GetOrCreateThread keeps things
    // working when the packet's trusted_pid is missing (older traces).
    UniqueTid utid =
        producer_pid != 0
            ? context_->process_tracker->UpdateThread(tid, producer_pid)
            : context_->process_tracker->GetOrCreateThread(tid);
    // Set the process name *first*, before any UpdateThreadName call: the
    // latter uses "MaybeProcessName" semantics and would otherwise overwrite
    // the process name with the main thread's name ("main" on zygote-forked
    // app processes).
    if (producer_pid != 0 && !producer_name.empty()) {
      context_->process_tracker->UpdateProcessName(
          context_->process_tracker->GetOrCreateProcess(producer_pid),
          context_->storage->InternString(base::StringView(producer_name)),
          ProcessNamePriority::kOther);
    }
    auto name_it = thread_names.find(tid);
    if (name_it != thread_names.end()) {
      context_->process_tracker->UpdateThreadName(
          utid,
          context_->storage->InternString(base::StringView(name_it->second)),
          ThreadNamePriority::kOther);
    }
    TrackId track_id = context_->track_tracker->InternThreadTrack(utid);

    size_t chunk_end = pos + kEntryChunkHeaderSize + chunk_size;
    if (chunk_end > size) {
      break;
    }
    size_t off = pos + kEntryChunkHeaderSize;

    int64_t prev_time_action = 0;
    int64_t prev_method_ptr = 0;
    for (uint32_t i = 0; i < num_records; i++) {
      int64_t time_action_diff = 0;
      if (!DecodeSignedLeb128(data, chunk_end, &off, &time_action_diff)) {
        break;
      }
      int64_t time_action = prev_time_action + time_action_diff;
      prev_time_action = time_action;
      bool is_exit = (time_action & 1) != 0;
      int64_t event_time_ns = time_action >> 1;

      if (is_exit) {
        context_->slice_tracker->End(event_time_ns, track_id);
      } else {
        int64_t method_diff = 0;
        if (!DecodeSignedLeb128(data, chunk_end, &off, &method_diff)) {
          break;
        }
        int64_t method_ptr = prev_method_ptr + method_diff;
        prev_method_ptr = method_ptr;
        StringId name_id = kNullStringId;
        auto m_it = method_names.find(static_cast<uint64_t>(method_ptr));
        if (m_it != method_names.end()) {
          name_id =
              context_->storage->InternString(base::StringView(m_it->second));
        }
        context_->slice_tracker->Begin(event_time_ns, track_id, kNullStringId,
                                       name_id);
      }
    }
    pos = chunk_end;
  }
}

}  // namespace perfetto::trace_processor
