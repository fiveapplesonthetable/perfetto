/*
 * Copyright (C) 2019 The Android Open Source Project
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

#include "src/trace_processor/forwarding_trace_parser.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "perfetto/base/logging.h"
#include "perfetto/base/status.h"
#include "perfetto/ext/base/status_macros.h"
#include "perfetto/ext/base/string_view.h"
#include "perfetto/trace_processor/basic_types.h"
#include "src/trace_processor/importers/common/chunked_trace_reader.h"
#include "src/trace_processor/importers/common/clock_tracker.h"
#include "src/trace_processor/importers/common/global_stats_tracker.h"
#include "src/trace_processor/importers/common/machine_tracker.h"
#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/importers/common/trace_file_tracker.h"
#include "src/trace_processor/sorter/trace_sorter.h"
#include "src/trace_processor/storage/stats.h"
#include "src/trace_processor/tables/metadata_tables_py.h"
#include "src/trace_processor/trace_reader_registry.h"
#include "src/trace_processor/types/trace_manifest_state.h"
#include "src/trace_processor/types/trace_processor_context.h"
#include "src/trace_processor/util/clock_synchronizer.h"
#include "src/trace_processor/util/trace_type.h"

#include "perfetto/ext/base/fnv_hash.h"
#include "perfetto/protozero/proto_decoder.h"
#include "protos/perfetto/common/builtin_clock.pbzero.h"
#include "protos/perfetto/common/system_info.pbzero.h"
#include "protos/perfetto/trace/clock_snapshot.pbzero.h"
#include "protos/perfetto/trace/trace.pbzero.h"
#include "protos/perfetto/trace/trace_packet.pbzero.h"

namespace perfetto::trace_processor {
namespace {

TraceSorter::SortingMode ConvertSortingMode(SortingMode sorting_mode) {
  switch (sorting_mode) {
    case SortingMode::kDefaultHeuristics:
      return TraceSorter::SortingMode::kDefault;
    case SortingMode::kForceFullSort:
      return TraceSorter::SortingMode::kFullSort;
  }
  PERFETTO_FATAL("For GCC");
}

std::optional<TraceSorter::SortingMode> GetMinimumSortingMode(
    TraceImporterId trace_type,
    const TraceProcessorContext& context) {
  const TraceTypeDescriptor* d =
      context.trace_importer_registry->Find(trace_type);
  PERFETTO_CHECK(d);
  switch (d->sort_policy) {
    case TraceSortPolicy::kFullSort:
      return TraceSorter::SortingMode::kFullSort;
    case TraceSortPolicy::kConfigDriven:
      return ConvertSortingMode(context.config.sorting_mode);
    case TraceSortPolicy::kNone:
      return std::nullopt;
  }
  PERFETTO_FATAL("For GCC");
}

// A file's boot/device fingerprint, read from the packets in its first
// chunk: REALTIME - BOOTTIME is the wall-clock time the kernel booted,
// identifying the boot; the SystemInfo identity fields distinguish devices
// whose boots happen to coincide.
struct BootFingerprint {
  int64_t boot_offset_ns = 0;
  uint64_t device_hash = 0;
};

// Boot-offset tolerance for "same boot": REALTIME can be adjusted (NTP)
// between two recordings of one boot, while distinct boots differ by at
// least the earlier boot's whole uptime plus the reboot itself.
constexpr int64_t kSameBootToleranceNs = 10ll * 1000 * 1000 * 1000;

std::optional<BootFingerprint> ScanBootFingerprint(const TraceBlobView& blob) {
  protozero::ProtoDecoder trace(blob.data(), blob.length());
  std::optional<int64_t> boot_offset;
  std::optional<uint64_t> device_hash;
  for (auto f = trace.ReadField(); f.valid(); f = trace.ReadField()) {
    if (f.id() != protos::pbzero::Trace::kPacketFieldNumber) {
      continue;
    }
    protos::pbzero::TracePacket::Decoder packet(f.as_bytes());
    if (packet.has_machine_id()) {
      continue;  // Remote-machine data does not describe this file's host.
    }
    if (!boot_offset && packet.has_clock_snapshot()) {
      protos::pbzero::ClockSnapshot::Decoder snapshot(packet.clock_snapshot());
      std::optional<int64_t> boottime;
      std::optional<int64_t> realtime;
      for (auto it = snapshot.clocks(); it; ++it) {
        protos::pbzero::ClockSnapshot::Clock::Decoder clock(*it);
        if (clock.clock_id() == protos::pbzero::BUILTIN_CLOCK_BOOTTIME) {
          boottime = static_cast<int64_t>(clock.timestamp());
        } else if (clock.clock_id() == protos::pbzero::BUILTIN_CLOCK_REALTIME) {
          realtime = static_cast<int64_t>(clock.timestamp());
        }
      }
      if (boottime && realtime) {
        boot_offset = *realtime - *boottime;
      }
    }
    if (!device_hash && packet.has_system_info()) {
      protos::pbzero::SystemInfo::Decoder info(packet.system_info());
      base::FnvHasher hasher;
      if (info.has_utsname()) {
        protos::pbzero::Utsname::Decoder utsname(info.utsname());
        hasher.Update(utsname.sysname().ToStdStringView());
        hasher.Update(utsname.release().ToStdStringView());
        hasher.Update(utsname.version().ToStdStringView());
        hasher.Update(utsname.machine().ToStdStringView());
      }
      hasher.Update(info.android_build_fingerprint().ToStdStringView());
      device_hash = hasher.digest();
    }
    if (boot_offset && device_hash) {
      break;
    }
  }
  if (!boot_offset) {
    return std::nullopt;
  }
  return BootFingerprint{*boot_offset, device_hash.value_or(0)};
}

// The machine for a fingerprinted file: files whose fingerprints match share
// a machine. The first fingerprinted file claims the host machine (raw id 0);
// each later distinct boot gets its own synthetic machine, so independent
// recordings never interleave their machine-scoped data (sched, cpu and gpu
// counters, ...) on one machine.
int64_t ResolveBootMachine(TraceProcessorContext* context,
                           const BootFingerprint& fingerprint,
                           bool* allocated_synthetic) {
  auto& machines = context->forked_context_state->boot_machines;
  *allocated_synthetic = false;
  for (const auto& m : machines) {
    if (m.device_hash == fingerprint.device_hash &&
        std::abs(m.boot_offset_ns - fingerprint.boot_offset_ns) <=
            kSameBootToleranceNs) {
      return m.raw_machine_id;
    }
  }
  int64_t raw_machine_id = 0;
  if (!machines.empty()) {
    raw_machine_id =
        kFirstBootMachineId + static_cast<int64_t>(machines.size()) - 1;
    *allocated_synthetic = true;
  }
  machines.push_back(
      {fingerprint.boot_offset_ns, fingerprint.device_hash, raw_machine_id});
  return raw_machine_id;
}

}  // namespace

ForwardingTraceParser::ForwardingTraceParser(TraceProcessorContext* context,
                                             tables::TraceFileTable::Id id)
    : input_context_(context), file_id_(id) {}

ForwardingTraceParser::~ForwardingTraceParser() = default;

base::Status ForwardingTraceParser::Init(const TraceBlobView& blob) {
  PERFETTO_CHECK(!reader_);

  {
    auto scoped_trace =
        input_context_->global_stats_tracker->TraceExecutionTimeIntoStats(
            stats::guess_trace_type_duration_ns);
    trace_type_ = input_context_->trace_importer_registry->Guess(blob.data(),
                                                                 blob.size());
  }
  if (!trace_type_) {
    // If renaming this error message don't remove the "(ERR:fmt)" part.
    // The UI's error_dialog.ts uses it to make the dialog more graceful.
    return base::ErrStatus("Unknown trace type provided (ERR:fmt)");
  }
  PERFETTO_DLOG("%s trace detected",
                input_context_->trace_importer_registry->ToString(trace_type_));

  const TraceTypeDescriptor* desc =
      input_context_->trace_importer_registry->Find(trace_type_);
  PERFETTO_CHECK(desc);

  if (file_id_.value != 0 && !desc->supports_nesting) {
    return base::ErrStatus(
        "Ninja traces currently do not support being contained inside other "
        "trace formats. Please file a bug at "
        "https://github.com/google/perfetto/issues if this is important to "
        "you.");
  }

  // A perfetto_manifest file configures the parsing of the files which
  // follow it, so it is only valid before any non-container trace. Archive
  // sorting guarantees this for direct members; this rejects e.g. a
  // gzip-wrapped metadata file sorted after a proto trace.
  if (desc->is_manifest &&
      input_context_->forked_context_state->trace_to_context.size() != 0) {
    return base::ErrStatus(
        "perfetto_manifest file must be the first trace file in the input");
  }

  std::optional<TraceSorter::SortingMode> minimum_sorting_mode =
      GetMinimumSortingMode(trace_type_, *input_context_);
  if (minimum_sorting_mode) {
    input_context_->sorter->SetSortingMode(*minimum_sorting_mode);
  }
  input_context_->trace_file_tracker->StartParsing(file_id_, trace_type_);

  // If the perfetto_manifest file has an entry for this file (matched by
  // exact path), it overrides clock/machine handling below.
  TraceManifestState::FileEntry* manifest_entry = FindManifestEntry();
  if (manifest_entry &&
      (manifest_entry->clock_override || manifest_entry->machine_id) &&
      !desc->forks_context) {
    return base::ErrStatus(
        "perfetto_manifest: overrides are not supported for trace files "
        "which are themselves archives or perfetto_manifest files: %s",
        manifest_entry->path.c_str());
  }

  if (!desc->forks_context) {
    // perfetto_manifest files produce no events: like containers they must
    // not fork a per-trace context, as that would make this file the
    // "primary" trace for its machine and demote the real traces.
    PERFETTO_DCHECK(!input_context_->trace_state);
    trace_context_ = input_context_;
  } else {
    int64_t raw_machine_id = manifest_entry && manifest_entry->machine_id
                                 ? *manifest_entry->machine_id
                                 : 0;
    // Without any explicit attribution, key the file's machine on the boot
    // (and device) it was recorded on: files from the same boot share a
    // machine, independent recordings get their own. A manifest entry always
    // takes precedence.
    bool synthetic_boot_machine = false;
    if (raw_machine_id == 0 && desc->has_boot_fingerprint) {
      if (auto fingerprint = ScanBootFingerprint(blob)) {
        raw_machine_id = ResolveBootMachine(input_context_, *fingerprint,
                                            &synthetic_boot_machine);
      }
    }
    // TODO(b/334978369) Make sure proto and systrace traces are parsed first so
    // that we do not get issues with SetPidZeroIsUpidZeroIdleProcess()
    // The machine row was pre-allocated by the manifest reader (which also
    // named it); this fork reuses it via MachineTracker.
    trace_context_ =
        input_context_->ForkContextForTrace(file_id_, raw_machine_id);
    if (synthetic_boot_machine) {
      // Label the machine with the file it came from, pending a
      // SystemInfo.machine_name from the trace itself.
      StringId name = input_context_->trace_file_tracker->GetName(file_id_);
      if (name != kNullStringId) {
        trace_context_->machine_tracker->SetMachineName(name);
      }
    }
    if (desc->pid_zero_is_idle) {
      trace_context_->process_tracker->SetPidZeroIsUpidZeroIdleProcess();
    }
    if (manifest_entry) {
      // A `machines` block declares the file IS multi-machine, so it is not a
      // single-machine override; instead the proto dispatcher remaps embedded
      // ids through it.
      bool is_multi = !manifest_entry->machine_mappings.empty();
      trace_context_->trace_state->has_machine_override =
          manifest_entry->machine_id.has_value() && !is_multi;
      if (is_multi) {
        trace_context_->trace_state->machine_remap =
            &manifest_entry->machine_remap;
      }
    }
  }
  ASSIGN_OR_RETURN(reader_, input_context_->reader_registry->CreateTraceReader(
                                trace_type_, trace_context_, file_id_.value));

  // Centralize clock setup for all trace formats. Every format declares the
  // clock domain its native timestamps are expressed in (its "trace clock"),
  // and we do three things with it:
  //
  //   1. Record it as the file's default clock, which tokenizers convert their
  //      events through via ClockTracker::ConvertDefaultClockToTraceTime. Proto
  //      is the exception (see below).
  //
  //   2. Claim it as the global trace-time clock. The first trace to claim
  //      wins; later claims are silently ignored, so the global clock is
  //      stable regardless of how many traces an archive (e.g. a ZIP) holds.
  //
  //   3. Register a deferred clock sync for the same clock (an implicit edge).
  //      If this trace does NOT win the global clock (e.g. a proto trace in the
  //      same archive claimed BOOTTIME first) and the trace clock is not
  //      otherwise linked into the clock graph via a ClockSnapshot, a
  //      zero-offset identity edge is injected on the first conversion. This
  //      keeps the trace's timestamps convertible instead of silently dropping
  //      every event. When a real ClockSnapshot does link the clock (e.g. proto
  //      provides BOOTTIME<->MONOTONIC), that real relationship is used
  //      instead.
  //
  // Proto traces are special: their clock is whatever ParseClockSnapshot reads
  // from primary_trace_clock, set later, so here we only register BOOTTIME as
  // the deferred fallback, do not set the default clock, and do not claim the
  // global clock now.
  //
  // A perfetto_manifest clock override for this file replaces the format's
  // best-effort source clock (below) with the file's own private clock and
  // customizes its implicit edge into the graph (see the manifest branch).
  using ClockId = ClockTracker::ClockId;
  std::optional<ClockId> trace_clock;
  switch (desc->clock_policy) {
    case TraceClockPolicy::kNone:
      break;
    case TraceClockPolicy::kMonotonic:
      trace_clock = ClockId::Machine(protos::pbzero::BUILTIN_CLOCK_MONOTONIC);
      break;
    case TraceClockPolicy::kBoottime:
      trace_clock = ClockId::Machine(protos::pbzero::BUILTIN_CLOCK_BOOTTIME);
      break;
    case TraceClockPolicy::kRealtime:
      trace_clock = ClockId::Machine(protos::pbzero::BUILTIN_CLOCK_REALTIME);
      break;
    case TraceClockPolicy::kTraceFile:
      trace_clock = ClockId::TraceFile(trace_context_->trace_id().value);
      break;
  }
  auto& clock_tracker = trace_context_->clock_tracker;

  // A perfetto_manifest "manual" clock override relates this file's clock to a
  // clock in another trace; the manifest reader has already added every such
  // edge to the global graph. A pinned (clockless) source also has no real
  // clock of its own, so flag it: the file is now single-clock / single-machine
  // and any ClockSnapshot or remote machine id on it is rejected. It still
  // converts through the default clock set up below, like any clockless format.
  if (manifest_entry && manifest_entry->clock_override &&
      !manifest_entry->clock_override->source_clock) {
    trace_context_->trace_state->has_clock_override = true;
  }

  // Set up the format's source clock. Proto manages its own default clock
  // (primary_trace_clock / ClockSnapshot) so it does not set the default clock
  // (sets_default_clock=false); every other format converts its events through
  // the default clock via ClockTracker::ConvertDefaultClockToTraceTime.
  if (trace_clock) {
    if (desc->sets_default_clock) {
      clock_tracker->SetTraceDefaultClock(*trace_clock);
    }
    if (desc->claims_global_clock) {
      clock_tracker->SetGlobalClock(*trace_clock);
    }
    clock_tracker->AddDeferredClockSync(*trace_clock);
  }
  return base::OkStatus();
}

TraceManifestState::FileEntry* ForwardingTraceParser::FindManifestEntry()
    const {
  auto* state = input_context_->trace_manifest_state.get();
  if (state->files.empty()) {
    return nullptr;
  }
  auto row = input_context_->storage->trace_file_table()[file_id_];
  if (!row.name()) {
    return nullptr;
  }
  return state->FindEntry(
      input_context_->storage->GetString(*row.name()).ToStdString());
}

base::Status ForwardingTraceParser::Parse(TraceBlobView blob) {
  // If this is the first Parse() call, guess the trace type and create the
  // appropriate parser.
  if (!reader_) {
    RETURN_IF_ERROR(Init(blob));
  }
  trace_size_ += blob.size();
  return reader_->Parse(std::move(blob));
}

base::Status ForwardingTraceParser::OnPushDataToSorter() {
  if (reader_) {
    return reader_->OnPushDataToSorter();
  }
  return base::OkStatus();
}

void ForwardingTraceParser::OnEventsFullyExtracted() {
  if (reader_) {
    reader_->OnEventsFullyExtracted();
  }
  if (trace_type_) {
    input_context_->trace_file_tracker->DoneParsing(file_id_, trace_size_);
  }
}

}  // namespace perfetto::trace_processor
