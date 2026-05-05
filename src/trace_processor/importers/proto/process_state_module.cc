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

#include "src/trace_processor/importers/proto/process_state_module.h"

#include <cstdint>
#include <optional>
#include <vector>

#include "perfetto/protozero/field.h"
#include "protos/perfetto/trace/android/process_state_data.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"
#include "src/trace_processor/importers/common/parser_types.h"
#include "src/trace_processor/importers/proto/proto_importer_module.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/tables/android_tables_py.h"

namespace perfetto::trace_processor {

namespace {
using ::perfetto::protos::pbzero::ProcessStateSnapshot;
using ::perfetto::protos::pbzero::TracePacket;
using ::protozero::ConstBytes;

// Look up an interned string by 1-based index. Returns kNullStringId if idx is
// 0 (proto-side sentinel for "absent") or out of range.
StringId LookupInterned(const std::vector<StringId>& interned, int32_t idx) {
  if (idx <= 0 || static_cast<size_t>(idx) >= interned.size()) {
    return kNullStringId;
  }
  return interned[static_cast<size_t>(idx)];
}
}  // namespace

ProcessStateModule::ProcessStateModule(
    ProtoImporterModuleContext* module_context,
    TraceProcessorContext* context)
    : ProtoImporterModule(module_context), context_(context) {
  RegisterForField(TracePacket::kProcessStateSnapshotFieldNumber);
}

ProcessStateModule::~ProcessStateModule() = default;

void ProcessStateModule::ParseTracePacketData(
    const TracePacket::Decoder& decoder,
    int64_t ts,
    const TracePacketData&,
    uint32_t field_id) {
  if (field_id != TracePacket::kProcessStateSnapshotFieldNumber) {
    return;
  }
  ParseSnapshot(ts, decoder.process_state_snapshot());
}

void ProcessStateModule::ParseSnapshot(int64_t ts, ConstBytes blob) {
  ProcessStateSnapshot::Decoder snap(blob);

  // Index 0 is reserved for "absent". Build a 1-based table.
  std::vector<StringId> interned;
  interned.push_back(kNullStringId);
  for (auto it = snap.interned_strings(); it; ++it) {
    interned.push_back(
        context_->storage->InternString((*it).ToStdStringView()));
  }

  // Top-level snapshot row. Prefer producer-supplied capture timestamp
  // over TracePacket emit time; for batched / rate-limited configs
  // emit time can lag the capture by hundreds of ms, misaligning the
  // snapshot against scheduling/binder tracks in the UI.
  tables::ProcessStateSnapshotTable::Row snap_row;
  snap_row.ts =
      snap.has_snapshot_boottime_ns() ? snap.snapshot_boottime_ns() : ts;
  snap_row.oom_adj_reason = snap.oom_adj_reason();
  if (snap.has_global_state()) {
    protos::pbzero::GlobalState::Decoder global(snap.global_state());
    if (global.has_top_pid()) {
      snap_row.top_pid = global.top_pid();
    }
  }
  snap_row.is_full =
      snap.kind() == protos::pbzero::ProcessStateSnapshot::KIND_ANCHOR ? 1 : 0;
  auto snap_id = context_->storage->mutable_process_state_snapshot_table()
                     ->Insert(snap_row)
                     .id;

  // Per-process rows.
  for (auto it = snap.process(); it; ++it) {
    protos::pbzero::ProcessRecord::Decoder pr(*it);

    tables::ProcessStateProcessTable::Row prow;
    prow.snapshot_id = snap_id;
    prow.pid = pr.pid();
    prow.uid = pr.uid();
    prow.user_id = pr.user_id();
    if (pr.has_process_name_idx()) {
      StringId s = LookupInterned(interned, pr.process_name_idx());
      if (!s.is_null())
        prow.process_name = s;
    }
    if (pr.has_package_name_idx()) {
      StringId s = LookupInterned(interned, pr.package_name_idx());
      if (!s.is_null())
        prow.package_name = s;
    }
    prow.lru_index = pr.lru_index();

    // ProtoOutputStream elides default values (0 / false) on the producer
    // side, so has_X() is unreliable as a "wasn't written" signal. Read
    // everything unconditionally and trust the proto3-style default semantics.
    prow.cur_adj = pr.cur_adj();
    prow.cur_raw_adj = pr.cur_raw_adj();
    prow.set_adj = pr.set_adj();
    prow.max_adj = pr.max_adj();
    prow.cur_proc_state = pr.cur_proc_state();
    prow.set_proc_state = pr.set_proc_state();
    prow.cur_raw_proc_state = pr.cur_raw_proc_state();
    prow.cur_capability = pr.cur_capability();
    prow.set_capability = pr.set_capability();
    prow.cur_sched_group = pr.cur_sched_group();
    prow.set_sched_group = pr.set_sched_group();
    prow.has_foreground_activities = pr.has_foreground_activities() ? 1 : 0;
    prow.has_top_ui = pr.has_top_ui() ? 1 : 0;
    prow.has_overlay_ui = pr.has_overlay_ui() ? 1 : 0;
    prow.has_shown_ui = pr.has_shown_ui() ? 1 : 0;
    prow.has_visible_activities = pr.has_visible_activities() ? 1 : 0;
    prow.has_started_services = pr.has_started_services() ? 1 : 0;
    prow.persistent = pr.persistent() ? 1 : 0;
    prow.isolated = pr.isolated() ? 1 : 0;
    prow.has_active_instrumentation = pr.has_active_instrumentation() ? 1 : 0;

    context_->storage->mutable_process_state_process_table()->Insert(prow);
  }

  // Per-uid rows.
  for (auto it = snap.uid(); it; ++it) {
    protos::pbzero::UidRecord::Decoder ur(*it);

    tables::ProcessStateUidTable::Row urow;
    urow.snapshot_id = snap_id;
    urow.uid = ur.uid();
    urow.cur_proc_state = ur.cur_proc_state();
    urow.set_proc_state = ur.set_proc_state();
    urow.cur_capability = ur.cur_capability();
    urow.idle = ur.idle() ? 1 : 0;
    urow.ephemeral = ur.ephemeral() ? 1 : 0;

    context_->storage->mutable_process_state_uid_table()->Insert(urow);
  }

  // Per-service rows.
  for (auto it = snap.service(); it; ++it) {
    protos::pbzero::ServiceRecord::Decoder sr(*it);

    tables::ProcessStateServiceTable::Row srow;
    srow.snapshot_id = snap_id;
    srow.service_id = sr.id();
    srow.owning_pid = sr.owning_pid();
    if (sr.has_short_name_idx()) {
      StringId s = LookupInterned(interned, sr.short_name_idx());
      if (!s.is_null())
        srow.short_name = s;
    }
    if (sr.has_package_name_idx()) {
      StringId s = LookupInterned(interned, sr.package_name_idx());
      if (!s.is_null())
        srow.package_name = s;
    }
    srow.is_foreground = sr.is_foreground() ? 1 : 0;
    srow.foreground_id = sr.foreground_id();
    srow.foreground_service_type = sr.foreground_service_type();
    srow.is_short_fgs = sr.is_short_fgs() ? 1 : 0;
    srow.start_requested = sr.start_requested() ? 1 : 0;
    srow.delayed = sr.delayed() ? 1 : 0;
    srow.delayed_stop = sr.delayed_stop() ? 1 : 0;
    srow.execute_nesting = sr.execute_nesting();
    srow.execute_fg = sr.execute_fg() ? 1 : 0;
    srow.restart_count = sr.restart_count();
    srow.crash_count = sr.crash_count();
    srow.is_isolated = sr.is_isolated() ? 1 : 0;

    context_->storage->mutable_process_state_service_table()->Insert(srow);
  }

  // Per-binding rows.
  for (auto it = snap.binding(); it; ++it) {
    protos::pbzero::ServiceBinding::Decoder b(*it);

    tables::ProcessStateBindingTable::Row brow;
    brow.snapshot_id = snap_id;
    brow.binding_id = b.id();
    brow.client_pid = b.client_pid();
    brow.client_uid = b.client_uid();
    if (b.has_client_process_name_idx()) {
      StringId s = LookupInterned(interned, b.client_process_name_idx());
      if (!s.is_null())
        brow.client_process_name = s;
    }
    brow.service_id = b.service_id();
    brow.flags = b.flags();
    brow.flag_auto_create = b.flag_auto_create() ? 1 : 0;
    brow.flag_foreground_service = b.flag_foreground_service() ? 1 : 0;
    brow.flag_not_foreground = b.flag_not_foreground() ? 1 : 0;
    brow.flag_above_client = b.flag_above_client() ? 1 : 0;
    brow.flag_allow_oom_management = b.flag_allow_oom_management() ? 1 : 0;
    brow.flag_waive_priority = b.flag_waive_priority() ? 1 : 0;
    brow.flag_important = b.flag_important() ? 1 : 0;
    brow.flag_adjust_with_activity = b.flag_adjust_with_activity() ? 1 : 0;
    brow.flag_include_capabilities = b.flag_include_capabilities() ? 1 : 0;
    brow.client_label = b.client_label();
    brow.service_dead = b.service_dead() ? 1 : 0;

    context_->storage->mutable_process_state_binding_table()->Insert(brow);
  }

  // Per-provider rows.
  for (auto it = snap.provider(); it; ++it) {
    protos::pbzero::ContentProviderRecord::Decoder cpr(*it);

    tables::ProcessStateProviderTable::Row prow;
    prow.snapshot_id = snap_id;
    prow.provider_id = cpr.id();
    prow.owning_pid = cpr.owning_pid();
    if (cpr.has_authority_idx()) {
      StringId s = LookupInterned(interned, cpr.authority_idx());
      if (!s.is_null())
        prow.authority = s;
    }
    if (cpr.has_package_name_idx()) {
      StringId s = LookupInterned(interned, cpr.package_name_idx());
      if (!s.is_null())
        prow.package_name = s;
    }
    if (cpr.has_class_name_idx()) {
      StringId s = LookupInterned(interned, cpr.class_name_idx());
      if (!s.is_null())
        prow.class_name = s;
    }
    prow.external_handle_count = cpr.external_handle_count();
    prow.launched = cpr.launched() ? 1 : 0;

    context_->storage->mutable_process_state_provider_table()->Insert(prow);
  }

  // Per-provider-binding rows.
  for (auto it = snap.provider_binding(); it; ++it) {
    protos::pbzero::ContentProviderBinding::Decoder cpc(*it);

    tables::ProcessStateProviderBindingTable::Row brow;
    brow.snapshot_id = snap_id;
    brow.binding_id = cpc.id();
    brow.provider_id = cpc.provider_id();
    brow.client_pid = cpc.client_pid();
    brow.stable_count = cpc.stable_count();
    brow.unstable_count = cpc.unstable_count();
    brow.dead = cpc.dead() ? 1 : 0;
    brow.waiting = cpc.waiting() ? 1 : 0;

    context_->storage->mutable_process_state_provider_binding_table()->Insert(
        brow);
  }

  // Mutation events emitted between snapshots.
  for (auto it = snap.event(); it; ++it) {
    protos::pbzero::MutationEvent::Decoder ev(*it);

    tables::ProcessStateMutationEventTable::Row mrow;
    mrow.snapshot_id = snap_id;
    mrow.ts = ev.boottime_ns();
    mrow.kind = ev.kind();
    mrow.pid = ev.pid();
    mrow.uid = ev.uid();
    mrow.service_id = ev.service_id();
    mrow.binding_id = ev.binding_id();
    mrow.provider_id = ev.provider_id();
    mrow.provider_binding_id = ev.provider_binding_id();
    mrow.prev_adj = ev.prev_adj();
    mrow.next_adj = ev.next_adj();
    mrow.prev_proc_state = ev.prev_proc_state();
    mrow.next_proc_state = ev.next_proc_state();
    mrow.prev_capability = ev.prev_capability();
    mrow.next_capability = ev.next_capability();
    mrow.prev_sched_group = ev.prev_sched_group();
    mrow.next_sched_group = ev.next_sched_group();
    mrow.oom_adj_reason = ev.oom_adj_reason();
    mrow.bind_flags = ev.bind_flags();
    mrow.fg_service_types = ev.fg_service_types();
    if (ev.has_label_idx()) {
      StringId s = LookupInterned(interned, ev.label_idx());
      if (!s.is_null())
        mrow.label = s;
    }

    context_->storage->mutable_process_state_mutation_event_table()->Insert(
        mrow);
  }

  // Adj computation traces.
  int32_t compute_index = 0;
  for (auto it = snap.adj_compute(); it; ++it) {
    protos::pbzero::AdjComputeTrace::Decoder t(*it);

    tables::ProcessStateAdjComputeTable::Row crow;
    crow.snapshot_id = snap_id;
    crow.compute_id = compute_index++;
    crow.pid = t.pid();
    crow.start_ts = t.start_boottime_ns();
    crow.duration_ns = t.duration_ns();
    crow.oom_adj_reason = t.oom_adj_reason();
    crow.final_adj = t.final_adj();
    crow.final_proc_state = t.final_proc_state();
    crow.final_capability = t.final_capability();
    crow.final_sched_group = t.final_sched_group();
    crow.prev_adj = t.prev_adj();
    crow.prev_proc_state = t.prev_proc_state();
    crow.prev_capability = t.prev_capability();
    crow.prev_sched_group = t.prev_sched_group();

    auto compute_id =
        context_->storage->mutable_process_state_adj_compute_table()
            ->Insert(crow)
            .id;

    int32_t step_index = 0;
    for (auto sit = t.step(); sit; ++sit) {
      protos::pbzero::AdjStep::Decoder s(*sit);

      tables::ProcessStateAdjStepTable::Row srow;
      srow.compute_id = compute_id;
      srow.step_index = step_index++;
      srow.kind = s.kind();
      srow.value = s.value();
      srow.binding_id = s.binding_id();
      srow.source_pid = s.source_pid();
      srow.chain_depth = s.chain_depth();
      if (s.has_note_idx()) {
        StringId si = LookupInterned(interned, s.note_idx());
        if (!si.is_null())
          srow.note = si;
      }

      context_->storage->mutable_process_state_adj_step_table()->Insert(srow);
    }
  }
}

}  // namespace perfetto::trace_processor
