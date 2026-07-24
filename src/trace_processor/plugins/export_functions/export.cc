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
//
// Serialize an arbitrary region or subset of a trace back into a native
// Perfetto proto trace (.pftrace), entirely from SQL. The intended use is
// carving a standalone trace out of a bigger one -- an app startup, one
// process's activity in a time window, a single async operation -- that
// trace_processor and the Perfetto UI re-open directly.
//
// DESIGN: small composable "packet builder" scalar functions, each of which
// turns one SQL row into a self-contained TracePacket (serialized as a one-
// packet proto Trace BLOB), plus one aggregate that frames a set of such BLOBs
// into a single Trace. A proto Trace is just a `repeated TracePacket`, so
// concatenating the serialized per-row Traces is itself a valid Trace; the
// aggregate does exactly that via protozero::AppendRawProtoBytes and prepends a
// single incremental-state-cleared preamble packet for the sequence.
//
// This factoring (vs. one mega-aggregate with many typed columns) lets a caller
// compose a trace in SQL by UNION-ing heterogeneous sources -- process/thread
// tracks from `thread`/`process`, slices from `slice`, counters from `counter`,
// thread states from `thread_state`, flows from `flow` -- each mapped by an
// ordinary SELECT into the matching builder, then folded by the aggregate:
//
//   SELECT __intrinsic_export_trace(packet) FROM (
//     SELECT __intrinsic_export_process_track(upid, pid, name) AS packet
//       FROM process WHERE upid = $p
//     UNION ALL
//     SELECT __intrinsic_export_thread_track(utid, upid, tid.pid, tid.tid, name)
//       FROM thread WHERE upid = $p
//     UNION ALL
//     SELECT __intrinsic_export_slice(track_id, ts, dur, name, NULL, NULL)
//       FROM slice WHERE ts BETWEEN $a AND $b
//     UNION ALL  -- thread scheduling states -> native thread_state + CPU tracks:
//     SELECT __intrinsic_export_task_state(ts, cpu, tid, comm, state, prio)
//       FROM thread_state ...
//     ...);
//
// Because the builders are stateless (one row in, one packet out) they cannot
// invent a shared interning dictionary on their own, so by default names are
// written *inline* (TrackEvent.name / TrackDescriptor.name), which is fully
// valid wire format and re-opens identically. Interning (a pure size
// optimization for names that repeat a lot, e.g. one slice name across 10^5
// slices) is still available without giving up composability: the caller
// assigns a stable iid per distinct name in SQL (dense_rank() over the names),
// emits one __intrinsic_export_event_name(iid, name) per distinct name, and
// references it from __intrinsic_export_slice_iid(..., name_iid, ...). All
// packets share one sequence whose incremental state the aggregate clears once
// up front; feeding the dictionary rows before the slice rows (an aggregate
// ORDER BY) puts each definition ahead of its uses on the sequence.

#include "src/trace_processor/plugins/export_functions/export_functions.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

#include "perfetto/base/logging.h"
#include "perfetto/ext/base/utils.h"
#include "perfetto/protozero/scattered_heap_buffer.h"
#include "protos/perfetto/trace/ftrace/ftrace_event.pbzero.h"
#include "protos/perfetto/trace/ftrace/ftrace_event_bundle.pbzero.h"
#include "protos/perfetto/trace/ftrace/sched.pbzero.h"
#include "protos/perfetto/trace/generic_kernel/generic_task.pbzero.h"
#include "protos/perfetto/trace/interned_data/interned_data.pbzero.h"
#include "protos/perfetto/trace/profiling/profile_common.pbzero.h"
#include "protos/perfetto/trace/track_event/counter_descriptor.pbzero.h"
#include "protos/perfetto/trace/track_event/process_descriptor.pbzero.h"
#include "protos/perfetto/trace/track_event/thread_descriptor.pbzero.h"
#include "protos/perfetto/trace/track_event/track_descriptor.pbzero.h"
#include "protos/perfetto/trace/track_event/track_event.pbzero.h"
#include "protos/perfetto/trace/trace.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/core/plugin/plugin.h"
#include "src/trace_processor/perfetto_sql/engine/perfetto_sql_connection.h"
#include "src/trace_processor/sqlite/bindings/sqlite_aggregate_function.h"
#include "src/trace_processor/sqlite/bindings/sqlite_function.h"
#include "src/trace_processor/sqlite/bindings/sqlite_result.h"
#include "src/trace_processor/sqlite/bindings/sqlite_type.h"
#include "src/trace_processor/sqlite/bindings/sqlite_value.h"
#include "src/trace_processor/sqlite/sqlite_utils.h"

namespace perfetto::trace_processor {

namespace {

using protos::pbzero::GenericKernelTaskStateEvent;
using protos::pbzero::Trace;
using protos::pbzero::TracePacket;
using protos::pbzero::TrackDescriptor;
using protos::pbzero::TrackEvent;

// All exported packets live on a single synthetic sequence. Track/track_event
// association is by global uuid, so no incremental state is required.
constexpr uint32_t kSeqId = 1;

bool IsNull(sqlite3_value* v) {
  return sqlite::value::Type(v) == sqlite::Type::kNull;
}

// Serialize a freshly-built one-packet Trace and hand it back as a BLOB. The
// bytes are copied by SQLite (kSqliteTransient) so the local buffer can die.
void ReturnTrace(sqlite3_context* ctx,
                 protozero::HeapBuffered<Trace>& trace) {
  std::vector<uint8_t> bytes = trace.SerializeAsArray();
  sqlite::result::TransientBytes(ctx, bytes.data(),
                                 static_cast<int>(bytes.size()));
}

// Parse a comma-separated list of unsigned integers (e.g. "10,20,30", the
// natural output of group_concat(flow_id)) into the given TrackEvent as either
// flow_ids or terminating_flow_ids. NULL / empty / non-text is a no-op.
void AddFlowIds(TrackEvent* te, sqlite3_value* v, bool terminating) {
  if (sqlite::value::Type(v) != sqlite::Type::kText) {
    return;
  }
  const char* s = sqlite::value::Text(v);
  if (s == nullptr) {
    return;
  }
  while (*s != '\0') {
    while (*s == ',' || *s == ' ') {
      ++s;
    }
    if (*s == '\0') {
      break;
    }
    char* end = nullptr;
    uint64_t id = std::strtoull(s, &end, 10);
    if (end == s) {
      break;  // not a number; stop rather than spin.
    }
    if (terminating) {
      te->add_terminating_flow_ids(id);
    } else {
      te->add_flow_ids(id);
    }
    s = end;
  }
}

// Emit a slice on `track_uuid` into `trace`: an INSTANT when dur is NULL or
// negative, otherwise a SLICE_BEGIN at ts + SLICE_END at ts+dur. `set_name`
// applies the opening event's name (inline string or interned iid); flows are
// attached to the opening event. When `needs_incremental` is set the opening
// packet is flagged SEQ_NEEDS_INCREMENTAL_STATE so the reader resolves any iid
// against the sequence's interned dictionary. Shared by the inline and interned
// slice builders so the two stay in lockstep.
template <typename SetName>
void EmitSlice(protozero::HeapBuffered<Trace>& trace,
               uint64_t track_uuid,
               int64_t ts,
               sqlite3_value* dur_v,
               const SetName& set_name,
               sqlite3_value* flows,
               sqlite3_value* terminating_flows,
               bool needs_incremental) {
  bool has_dur = !IsNull(dur_v);
  int64_t dur = has_dur ? sqlite::value::Int64(dur_v) : -1;
  bool instant = !has_dur || dur < 0;
  {
    auto* p = trace->add_packet();
    p->set_timestamp(static_cast<uint64_t>(ts));
    p->set_trusted_packet_sequence_id(kSeqId);
    if (needs_incremental) {
      p->set_sequence_flags(TracePacket::SEQ_NEEDS_INCREMENTAL_STATE);
    }
    auto* te = p->set_track_event();
    te->set_track_uuid(track_uuid);
    te->set_type(instant ? TrackEvent::TYPE_INSTANT
                         : TrackEvent::TYPE_SLICE_BEGIN);
    set_name(te);
    AddFlowIds(te, flows, /*terminating=*/false);
    AddFlowIds(te, terminating_flows, /*terminating=*/true);
  }
  if (!instant) {
    auto* p = trace->add_packet();
    p->set_timestamp(static_cast<uint64_t>(ts + dur));
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* te = p->set_track_event();
    te->set_track_uuid(track_uuid);
    te->set_type(TrackEvent::TYPE_SLICE_END);
  }
}

// __intrinsic_export_process_track(uuid, pid, name) -> BLOB
// A process-global track. trace_processor merges its events with ftrace slices
// for the same pid and uses it to root the process in the track tree.
struct ExportProcessTrack : public sqlite::Function<ExportProcessTrack> {
  static constexpr char kName[] = "__intrinsic_export_process_track";
  static constexpr int kArgCount = 3;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* td = p->set_track_descriptor();
    td->set_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    // All scalar TrackDescriptor fields must be written before opening the
    // nested ProcessDescriptor; protozero finalizes a child submessage as soon
    // as the parent is written to again.
    const char* name = IsNull(argv[2]) ? nullptr : sqlite::value::Text(argv[2]);
    if (name != nullptr) {
      td->set_name(name);
    }
    auto* proc = td->set_process();
    proc->set_pid(static_cast<int32_t>(sqlite::value::Int64(argv[1])));
    if (name != nullptr) {
      proc->set_process_name(name);
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_thread_track(uuid, parent_uuid, pid, tid, name) -> BLOB
// A thread-scoped track. Setting `thread` makes trace_processor nest it under
// the process with the same pid (thread-under-process) and associate a utid.
struct ExportThreadTrack : public sqlite::Function<ExportThreadTrack> {
  static constexpr char kName[] = "__intrinsic_export_thread_track";
  static constexpr int kArgCount = 5;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* td = p->set_track_descriptor();
    td->set_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    if (!IsNull(argv[1])) {
      td->set_parent_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[1])));
    }
    auto* thread = td->set_thread();
    thread->set_pid(static_cast<int32_t>(sqlite::value::Int64(argv[2])));
    thread->set_tid(static_cast<int32_t>(sqlite::value::Int64(argv[3])));
    if (!IsNull(argv[4])) {
      thread->set_thread_name(sqlite::value::Text(argv[4]));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_track(uuid, parent_uuid, name) -> BLOB
// A generic named track. With parent_uuid this builds arbitrary track trees
// (e.g. process -> async, or nested async), which is how async/track hierarchy
// is rebuilt by the caller.
struct ExportTrack : public sqlite::Function<ExportTrack> {
  static constexpr char kName[] = "__intrinsic_export_track";
  static constexpr int kArgCount = 3;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* td = p->set_track_descriptor();
    td->set_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    if (!IsNull(argv[1])) {
      td->set_parent_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[1])));
    }
    if (!IsNull(argv[2])) {
      td->set_name(sqlite::value::Text(argv[2]));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_counter_track(uuid, parent_uuid, name) -> BLOB
// A counter track. The CounterDescriptor marks it as counter-typed; parent_uuid
// nests it under a process/thread track when desired.
struct ExportCounterTrack : public sqlite::Function<ExportCounterTrack> {
  static constexpr char kName[] = "__intrinsic_export_counter_track";
  static constexpr int kArgCount = 3;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* td = p->set_track_descriptor();
    td->set_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    if (!IsNull(argv[1])) {
      td->set_parent_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[1])));
    }
    if (!IsNull(argv[2])) {
      td->set_name(sqlite::value::Text(argv[2]));
    }
    td->set_counter();  // presence marks the track as a counter track.
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_slice(track_uuid, ts, dur, name, flow_ids,
//                          terminating_flow_ids) -> BLOB
// One slice on a track. A NULL or negative dur produces a single instant event;
// otherwise a BEGIN/END pair framing [ts, ts+dur]. flow_ids /
// terminating_flow_ids are comma-separated id lists attached to the opening
// event so flow arrows survive. (Thread scheduling state is NOT exported as
// slices -- use __intrinsic_export_task_state, which rebuilds the native
// thread_state table and CPU tracks.)
struct ExportSlice : public sqlite::Function<ExportSlice> {
  static constexpr char kName[] = "__intrinsic_export_slice";
  static constexpr int kArgCount = 6;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    EmitSlice(
        trace, static_cast<uint64_t>(sqlite::value::Int64(argv[0])),
        sqlite::value::Int64(argv[1]), argv[2],
        [&](TrackEvent* te) {
          if (!IsNull(argv[3])) {
            te->set_name(sqlite::value::Text(argv[3]));
          }
        },
        argv[4], argv[5], /*needs_incremental=*/false);
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_event_name(iid, name) -> BLOB
// One interned event-name dictionary entry: interned_data.event_names{iid,name}
// on the shared sequence. Emit one per distinct name with a stable iid (>0,
// e.g. dense_rank() over the names) and reference it from
// __intrinsic_export_slice_iid. Ordering: these must reach the aggregate before
// the slices that use them (an aggregate ORDER BY), so each iid is defined on
// the sequence before its first use.
struct ExportEventName : public sqlite::Function<ExportEventName> {
  static constexpr char kName[] = "__intrinsic_export_event_name";
  static constexpr int kArgCount = 2;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    p->set_sequence_flags(TracePacket::SEQ_NEEDS_INCREMENTAL_STATE);
    auto* en = p->set_interned_data()->add_event_names();
    en->set_iid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    if (!IsNull(argv[1])) {
      en->set_name(sqlite::value::Text(argv[1]));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_slice_iid(track_uuid, ts, dur, name_iid, flow_ids,
//                              terminating_flow_ids) -> BLOB
// Same as __intrinsic_export_slice but names the slice by an interned iid (see
// __intrinsic_export_event_name) instead of an inline string, trading a ~1-2
// byte varint for a repeated string. Everything else -- instants, BEGIN/END,
// flows -- is identical.
struct ExportSliceInterned : public sqlite::Function<ExportSliceInterned> {
  static constexpr char kName[] = "__intrinsic_export_slice_iid";
  static constexpr int kArgCount = 6;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    EmitSlice(
        trace, static_cast<uint64_t>(sqlite::value::Int64(argv[0])),
        sqlite::value::Int64(argv[1]), argv[2],
        [&](TrackEvent* te) {
          if (!IsNull(argv[3])) {
            te->set_name_iid(
                static_cast<uint64_t>(sqlite::value::Int64(argv[3])));
          }
        },
        argv[4], argv[5], /*needs_incremental=*/true);
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_counter(track_uuid, ts, value) -> BLOB
// One sample on a counter track (see __intrinsic_export_counter_track).
struct ExportCounter : public sqlite::Function<ExportCounter> {
  static constexpr char kName[] = "__intrinsic_export_counter";
  static constexpr int kArgCount = 3;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_timestamp(static_cast<uint64_t>(sqlite::value::Int64(argv[1])));
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* te = p->set_track_event();
    te->set_type(TrackEvent::TYPE_COUNTER);
    te->set_track_uuid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    te->set_double_counter_value(sqlite::value::Double(argv[2]));
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_task_state(ts, cpu, tid, comm, state, prio) -> BLOB
// A generic-kernel thread state-change event. From a stream of these,
// trace_processor infers *native* thread_state (the real per-thread state track
// under each thread) AND per-CPU scheduling slices (the CPU tracks) -- the same
// tables ftrace sched_switch/sched_waking produce, without reconstructing raw
// switch pairs. `state` is trace_processor's own thread_state string
// ('Running','R'/'R+','S','D','T','Z','X'); `cpu` matters only for 'Running'
// (it is the CPU the thread runs on, which builds that CPU's track). Emit one
// row per thread_state transition inside the window. A state with no generic-
// kernel equivalent yields NULL (skipped by the aggregate) rather than a bad
// event. thread_state.blocked_function is carried separately, by
// __intrinsic_export_blocked_reason (a sched_blocked_reason ftrace event).
struct ExportTaskState : public sqlite::Function<ExportTaskState> {
  static constexpr char kName[] = "__intrinsic_export_task_state";
  static constexpr int kArgCount = 6;

  static GenericKernelTaskStateEvent::TaskStateEnum MapState(const char* s) {
    using E = protos::pbzero::GenericKernelTaskStateEvent;
    if (s == nullptr || *s == '\0') {
      return E::TASK_STATE_UNKNOWN;
    }
    if (std::strcmp(s, "Running") == 0) {
      return E::TASK_STATE_RUNNING;
    }
    switch (s[0]) {
      case 'R':  // R, R+
        return E::TASK_STATE_RUNNABLE;
      case 'S':
        return E::TASK_STATE_INTERRUPTIBLE_SLEEP;
      case 'D':  // D, D+
        return E::TASK_STATE_UNINTERRUPTIBLE_SLEEP;
      case 'T':
      case 't':
        return E::TASK_STATE_STOPPED;
      case 'Z':
        return E::TASK_STATE_DEAD;
      case 'X':
      case 'x':
        return E::TASK_STATE_DESTROYED;
      default:
        return E::TASK_STATE_UNKNOWN;
    }
  }

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    auto state =
        MapState(IsNull(argv[4]) ? nullptr : sqlite::value::Text(argv[4]));
    if (state == GenericKernelTaskStateEvent::TASK_STATE_UNKNOWN) {
      return;  // no equivalent -> NULL row, skipped by the aggregate.
    }
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_timestamp(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    p->set_trusted_packet_sequence_id(kSeqId);
    auto* ev = p->set_generic_kernel_task_state_event();
    if (!IsNull(argv[1])) {
      ev->set_cpu(static_cast<int32_t>(sqlite::value::Int64(argv[1])));
    }
    ev->set_tid(sqlite::value::Int64(argv[2]));
    if (!IsNull(argv[3])) {
      ev->set_comm(sqlite::value::Text(argv[3]));
    }
    ev->set_state(state);
    if (!IsNull(argv[5])) {
      ev->set_prio(static_cast<int32_t>(sqlite::value::Int64(argv[5])));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_kernel_symbol(iid, name) -> BLOB
// One interned kernel-symbol entry (InternedData.kernel_symbols). A blocked
// reason names its blocked_function by referencing one of these iids. Emit one
// per distinct blocked_function, ahead of the blocked-reason events on the
// sequence (aggregate ORDER BY), so the iid is defined before first use.
struct ExportKernelSymbol : public sqlite::Function<ExportKernelSymbol> {
  static constexpr char kName[] = "__intrinsic_export_kernel_symbol";
  static constexpr int kArgCount = 2;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    p->set_sequence_flags(TracePacket::SEQ_NEEDS_INCREMENTAL_STATE);
    auto* sym = p->set_interned_data()->add_kernel_symbols();
    sym->set_iid(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    if (!IsNull(argv[1])) {
      const char* s = sqlite::value::Text(argv[1]);
      sym->set_str(reinterpret_cast<const uint8_t*>(s), std::strlen(s));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_blocked_reason(ts, cpu, tid, caller_iid, io_wait) -> BLOB
// A sched_blocked_reason ftrace event. It annotates the thread's most recent
// blocked (D) state -- which __intrinsic_export_task_state must already have
// created -- with its blocked_function (caller_iid -> a kernel symbol emitted by
// __intrinsic_export_kernel_symbol) and io_wait flag. Emitted as a single-event
// ftrace bundle; ftrace defaults to the boot clock, the same time domain as the
// thread_state timestamps, so no clock snapshot is needed.
struct ExportBlockedReason : public sqlite::Function<ExportBlockedReason> {
  static constexpr char kName[] = "__intrinsic_export_blocked_reason";
  static constexpr int kArgCount = 5;

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    auto tid = static_cast<int32_t>(sqlite::value::Int64(argv[2]));
    protozero::HeapBuffered<Trace> trace;
    auto* p = trace->add_packet();
    p->set_trusted_packet_sequence_id(kSeqId);
    p->set_sequence_flags(TracePacket::SEQ_NEEDS_INCREMENTAL_STATE);
    auto* bundle = p->set_ftrace_events();
    bundle->set_cpu(IsNull(argv[1])
                        ? 0u
                        : static_cast<uint32_t>(sqlite::value::Int64(argv[1])));
    auto* ev = bundle->add_event();
    ev->set_timestamp(static_cast<uint64_t>(sqlite::value::Int64(argv[0])));
    ev->set_pid(static_cast<uint32_t>(tid));
    auto* sbr = ev->set_sched_blocked_reason();
    sbr->set_pid(tid);
    sbr->set_caller(static_cast<uint64_t>(sqlite::value::Int64(argv[3])));
    if (!IsNull(argv[4])) {
      sbr->set_io_wait(static_cast<uint32_t>(sqlite::value::Int64(argv[4])));
    }
    ReturnTrace(ctx, trace);
  }
};

// __intrinsic_export_trace(packet BLOB) -> BLOB (aggregate)
// Frame a set of per-row packet BLOBs (each a serialized one-or-more-packet
// Trace produced by the builders above) into a single Trace. Emits a leading
// incremental-state-cleared packet for the sequence, then appends each row's
// raw proto bytes -- valid because a Trace is a `repeated TracePacket`.
struct ExportTraceAgg : public sqlite::AggregateFunction<ExportTraceAgg> {
  static constexpr char kName[] = "__intrinsic_export_trace";
  static constexpr int kArgCount = 1;

  // Accumulated packet blobs, concatenated in Final().
  struct State {
    std::vector<uint8_t> bytes;
  };

  static void Step(sqlite3_context* ctx, int, sqlite3_value** argv) {
    if (sqlite::value::Type(argv[0]) != sqlite::Type::kBlob) {
      return;  // skip NULL / non-blob rows.
    }
    auto** state = static_cast<State**>(
        sqlite3_aggregate_context(ctx, sizeof(State*)));
    if (*state == nullptr) {
      *state = new State();
    }
    const auto* data =
        static_cast<const uint8_t*>(sqlite::value::Blob(argv[0]));
    int size = sqlite::value::Bytes(argv[0]);
    (*state)->bytes.insert((*state)->bytes.end(), data, data + size);
  }

  static void Final(sqlite3_context* ctx) {
    auto** state_ptr =
        static_cast<State**>(sqlite3_aggregate_context(ctx, 0));
    if (state_ptr == nullptr || *state_ptr == nullptr) {
      return sqlite3_result_null(ctx);
    }
    std::unique_ptr<State> state(*state_ptr);  // adopt + free.

    protozero::HeapBuffered<Trace> trace;
    // Preamble: clear incremental state for the sequence exactly once.
    {
      auto* p = trace->add_packet();
      p->set_trusted_packet_sequence_id(kSeqId);
      p->set_sequence_flags(TracePacket::SEQ_INCREMENTAL_STATE_CLEARED);
    }
    trace->AppendRawProtoBytes(state->bytes.data(), state->bytes.size());
    ReturnTrace(ctx, trace);
  }
};

}  // namespace

}  // namespace perfetto::trace_processor

namespace perfetto::trace_processor::export_functions {
namespace {

class ExportFunctionsPlugin : public Plugin<ExportFunctionsPlugin> {
 public:
  ~ExportFunctionsPlugin() override;

  void RegisterFunctions(PerfettoSqlConnection*,
                         std::vector<FunctionRegistration>& out) override {
    out.push_back(MakeFunctionRegistration<ExportProcessTrack>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportThreadTrack>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportTrack>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportCounterTrack>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportSlice>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportSliceInterned>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportEventName>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportCounter>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportTaskState>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportKernelSymbol>(nullptr));
    out.push_back(MakeFunctionRegistration<ExportBlockedReason>(nullptr));
  }

  void RegisterAggregateFunctions(
      PerfettoSqlConnection*,
      std::vector<AggregateFunctionRegistration>& out) override {
    out.push_back(MakeAggregateRegistration<ExportTraceAgg>(nullptr));
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
