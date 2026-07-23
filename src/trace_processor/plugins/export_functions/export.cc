// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// PROTOTYPE: serialize a set of slice rows into a native Perfetto proto trace,
// entirely from SQL. The intended use is extracting a region -- an app startup,
// a process's activity in a time window -- into a standalone .pftrace:
//
//   SELECT __intrinsic_export_slice_trace(s.name, s.ts, s.dur)
//   FROM slice s JOIN thread_track tt ON s.track_id = tt.id
//   JOIN thread USING (utid) WHERE upid = $p AND s.ts BETWEEN $a AND $b;
//
// The result BLOB is a gzip-free proto Trace (varint-packed, names interned) that
// trace_processor / the Perfetto UI re-open directly, so no compression is
// needed. This is a proof of concept: one synthetic track, slices only (begin/
// end), single sequence. Counters, thread_state and real track topology are the
// obvious extensions and are why a C++ exporter -- not raw build_proto in SQL --
// is the right home (interning + Trace framing + nested repeated fields).

#include "src/trace_processor/plugins/export_functions/export_functions.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "perfetto/base/logging.h"
#include "perfetto/ext/base/utils.h"
#include "perfetto/protozero/scattered_heap_buffer.h"
#include "protos/perfetto/trace/interned_data/interned_data.pbzero.h"
#include "protos/perfetto/trace/trace.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "protos/perfetto/trace/track_event/track_descriptor.pbzero.h"
#include "protos/perfetto/trace/track_event/track_event.pbzero.h"
#include "src/trace_processor/core/plugin/plugin.h"
#include "src/trace_processor/perfetto_sql/engine/perfetto_sql_connection.h"
#include "src/trace_processor/sqlite/bindings/sqlite_aggregate_function.h"
#include "src/trace_processor/sqlite/bindings/sqlite_result.h"

namespace perfetto::trace_processor {

namespace {

constexpr uint64_t kTrackUuid = 1;
constexpr uint32_t kSeqId = 1;

// Accumulated across Step() calls; drained in Final().
struct ExportState {
  struct Slice {
    int64_t ts;
    int64_t dur;
    std::string name;
  };
  std::vector<Slice> slices;
};

// __intrinsic_export_slice_trace(name, ts, dur) -> BLOB (a proto Trace).
struct ExportSliceTrace
    : public sqlite::AggregateFunction<ExportSliceTrace> {
  static constexpr char kName[] = "__intrinsic_export_slice_trace";
  static constexpr int kArgCount = 3;

  static void Step(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
    if (argc != 3) {
      return sqlite::result::Error(
          ctx, "__intrinsic_export_slice_trace: expected (name, ts, dur)");
    }
    // Double-indirection: sqlite zeroes the aggregate context on first use, so
    // the stored pointer is null until we new the state.
    auto** state = static_cast<ExportState**>(
        sqlite3_aggregate_context(ctx, sizeof(ExportState*)));
    if (*state == nullptr) {
      *state = new ExportState();
    }
    const auto* name =
        reinterpret_cast<const char*>(sqlite3_value_text(argv[0]));
    (*state)->slices.push_back({sqlite3_value_int64(argv[1]),
                                sqlite3_value_int64(argv[2]),
                                name ? name : ""});
  }

  static void Final(sqlite3_context* ctx) {
    auto** state_ptr =
        static_cast<ExportState**>(sqlite3_aggregate_context(ctx, 0));
    if (state_ptr == nullptr || *state_ptr == nullptr) {
      return sqlite3_result_null(ctx);  // no rows
    }
    std::unique_ptr<ExportState> state(*state_ptr);  // adopt + free

    // Intern names (first-appearance order) and expand slices into a
    // time-ordered begin/end event stream.
    std::unordered_map<std::string, uint64_t> iid_of;
    struct Ev {
      int64_t ts;
      bool begin;
      uint64_t iid;
    };
    std::vector<Ev> evs;
    evs.reserve(state->slices.size() * 2);
    for (const auto& s : state->slices) {
      auto it = iid_of.find(s.name);
      uint64_t iid = it != iid_of.end() ? it->second : (iid_of.size() + 1);
      if (it == iid_of.end()) {
        iid_of.emplace(s.name, iid);
      }
      evs.push_back({s.ts, true, iid});
      evs.push_back({s.ts + s.dur, false, iid});
    }
    std::sort(evs.begin(), evs.end(), [](const Ev& a, const Ev& b) {
      if (a.ts != b.ts) {
        return a.ts < b.ts;
      }
      return !a.begin && b.begin;  // close (END) before open (BEGIN) at a tie
    });

    protozero::HeapBuffered<protos::pbzero::Trace> trace;

    // Packet 1: declare the track and the interned event names.
    {
      auto* p = trace->add_packet();
      p->set_trusted_packet_sequence_id(kSeqId);
      p->set_sequence_flags(
          protos::pbzero::TracePacket::SEQ_INCREMENTAL_STATE_CLEARED);
      auto* td = p->set_track_descriptor();
      td->set_uuid(kTrackUuid);
      td->set_name("sql_export");
      auto* interned = p->set_interned_data();
      std::vector<std::pair<std::string, uint64_t>> names(iid_of.begin(),
                                                          iid_of.end());
      std::sort(names.begin(), names.end(),
                [](const auto& a, const auto& b) { return a.second < b.second; });
      for (const auto& n : names) {
        auto* en = interned->add_event_names();
        en->set_iid(n.second);
        en->set_name(n.first);
      }
    }

    // One packet per slice-begin / slice-end event.
    for (const auto& e : evs) {
      auto* p = trace->add_packet();
      p->set_timestamp(static_cast<uint64_t>(e.ts));
      p->set_trusted_packet_sequence_id(kSeqId);
      auto* te = p->set_track_event();
      te->set_track_uuid(kTrackUuid);
      if (e.begin) {
        te->set_type(protos::pbzero::TrackEvent::TYPE_SLICE_BEGIN);
        te->set_name_iid(e.iid);
      } else {
        te->set_type(protos::pbzero::TrackEvent::TYPE_SLICE_END);
      }
    }

    std::vector<uint8_t> bytes = trace.SerializeAsArray();
    auto size = static_cast<int>(bytes.size());
    std::unique_ptr<uint8_t, base::FreeDeleter> dst(
        reinterpret_cast<uint8_t*>(malloc(bytes.size())));
    memcpy(dst.get(), bytes.data(), bytes.size());
    return sqlite::result::RawBytes(ctx, dst.release(), size, free);
  }
};

}  // namespace

}  // namespace perfetto::trace_processor

namespace perfetto::trace_processor::export_functions {
namespace {

class ExportFunctionsPlugin : public Plugin<ExportFunctionsPlugin> {
 public:
  ~ExportFunctionsPlugin() override;
  void RegisterAggregateFunctions(
      PerfettoSqlConnection*,
      std::vector<AggregateFunctionRegistration>& out) override {
    out.push_back(MakeAggregateRegistration<ExportSliceTrace>(nullptr));
  }
};
ExportFunctionsPlugin::~ExportFunctionsPlugin() = default;

}  // namespace

void RegisterPlugin() {
  static PluginRegistration reg(
      []() -> std::unique_ptr<PluginBase> {
        return std::make_unique<ExportFunctionsPlugin>();
      },
      ExportFunctionsPlugin::kPluginId, ExportFunctionsPlugin::kDepIds.data(),
      ExportFunctionsPlugin::kDepIds.size());
  base::ignore_result(reg);
}

}  // namespace perfetto::trace_processor::export_functions
