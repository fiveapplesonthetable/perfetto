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

#include "src/trace_processor/plugins/android_process_state/android_process_tracker.h"

#include <cstdint>
#include <optional>

#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor::android_process_state {

AndroidProcessTracker::AndroidProcessTracker(TraceProcessorContext* context)
    : context_(context) {}

AndroidProcessTracker::~AndroidProcessTracker() = default;

UniquePid AndroidProcessTracker::GetOrStartProcess(
    std::optional<int64_t> start_ts,
    int64_t pid,
    std::optional<int64_t> start_seq_id,
    StringId name) {
  ProcessTracker* process_tracker = context_->process_tracker.get();

  // Looked up first: the pid may since have been handed to a newer process,
  // and a late event for this one must not disturb that.
  if (start_seq_id) {
    if (auto known = FindProcess(pid, *start_seq_id); known) {
      process_tracker->UpdateProcessName(*known, name,
                                         ProcessNamePriority::kSystem);
      return *known;
    }
  }

  std::optional<UniquePid> live_upid = process_tracker->GetProcessOrNull(pid);
  if (live_upid &&
      IsSameIncarnation(*live_upid, start_ts, start_seq_id, name)) {
    if (start_seq_id) {
      Bind(*live_upid, *start_seq_id);
    }
    RememberMainThread(*live_upid, pid);
    process_tracker->UpdateProcessName(*live_upid, name,
                                       ProcessNamePriority::kSystem);
    return *live_upid;
  }

  if (live_upid) {
    RememberMainThread(*live_upid, pid);
    recycled_upid_by_pid_[pid] = *live_upid;
  }
  UniquePid upid = process_tracker->StartNewProcess(
      start_ts, std::nullopt, pid, name, ThreadNamePriority::kOther);
  RememberMainThread(upid, pid);
  if (start_seq_id) {
    Bind(upid, *start_seq_id);
  }
  return upid;
}

std::optional<UniquePid> AndroidProcessTracker::EndProcess(
    int64_t ts,
    int64_t pid,
    int64_t start_seq_id) {
  ProcessTracker* process_tracker = context_->process_tracker.get();
  std::optional<UniquePid> live_upid = process_tracker->GetProcessOrNull(pid);

  std::optional<UniquePid> upid = FindProcess(pid, start_seq_id);
  if (!upid && live_upid) {
    if (!GetStartSeqId(*live_upid)) {
      // The owner of the pid was never seen with a seq id: nothing says it
      // is not the one that died.
      upid = live_upid;
    } else if (UniquePid* prev = recycled_upid_by_pid_.Find(pid);
               prev && !GetStartSeqId(*prev)) {
      // The owner is a different, known incarnation. The only candidate is
      // the one it displaced.
      upid = *prev;
    }
  }
  if (!upid) {
    return std::nullopt;
  }
  if (!GetStartSeqId(*upid)) {
    Bind(*upid, start_seq_id);
  }

  if (upid == live_upid && process_tracker->GetThreadOrNull(pid)) {
    // Also ends the main thread and detaches the pid.
    process_tracker->EndThread(ts, pid);
  } else {
    auto process = (*context_->storage->mutable_process_table())[*upid];
    if (!process.end_ts()) {
      process.set_end_ts(ts);
    }
    if (UniqueTid* utid = main_utid_by_upid_.Find(*upid); utid) {
      auto thread = (*context_->storage->mutable_thread_table())[*utid];
      if (!thread.end_ts()) {
        thread.set_end_ts(ts);
      }
    }
  }
  return upid;
}

std::optional<int64_t> AndroidProcessTracker::GetStartSeqId(
    UniquePid upid) const {
  const int64_t* start_seq_id = start_seq_id_by_upid_.Find(upid);
  return start_seq_id ? std::make_optional(*start_seq_id) : std::nullopt;
}

bool AndroidProcessTracker::IsSameIncarnation(
    UniquePid live_upid,
    std::optional<int64_t> start_ts,
    std::optional<int64_t> start_seq_id,
    StringId name) const {
  if (std::optional<int64_t> live_seq_id = GetStartSeqId(live_upid);
      live_seq_id && start_seq_id) {
    return *live_seq_id == *start_seq_id;
  }
  if (!start_ts) {
    // Not a start event: the current owner is the best we know.
    return true;
  }
  // A start event for a pid whose owner was seen without its own start and
  // under another name: that owner was running before the trace and has
  // since died.
  auto live = context_->storage->process_table()[live_upid];
  return live.start_ts() || !live.name() || name.is_null() ||
         *live.name() == name;
}

std::optional<UniquePid> AndroidProcessTracker::FindProcess(
    int64_t pid,
    int64_t start_seq_id) const {
  const UniquePid* upid = upid_by_seq_id_.Find(start_seq_id);
  if (!upid || context_->storage->process_table()[*upid].pid() != pid) {
    return std::nullopt;
  }
  return *upid;
}

void AndroidProcessTracker::RememberMainThread(UniquePid upid, int64_t pid) {
  if (main_utid_by_upid_.Find(upid)) {
    return;
  }
  std::optional<UniqueTid> utid =
      context_->process_tracker->GetThreadOrNull(pid);
  if (utid && context_->storage->thread_table()[*utid].upid() == upid) {
    main_utid_by_upid_.Insert(upid, *utid);
  }
}

void AndroidProcessTracker::Bind(UniquePid upid, int64_t start_seq_id) {
  start_seq_id_by_upid_[upid] = start_seq_id;
  upid_by_seq_id_[start_seq_id] = upid;
}

}  // namespace perfetto::trace_processor::android_process_state
