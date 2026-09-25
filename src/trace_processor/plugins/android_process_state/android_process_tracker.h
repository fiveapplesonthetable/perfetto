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

#ifndef SRC_TRACE_PROCESSOR_PLUGINS_ANDROID_PROCESS_STATE_ANDROID_PROCESS_TRACKER_H_
#define SRC_TRACE_PROCESSOR_PLUGINS_ANDROID_PROCESS_STATE_ANDROID_PROCESS_TRACKER_H_

#include <cstdint>
#include <optional>

#include "perfetto/ext/base/flat_hash_map.h"
#include "src/trace_processor/storage/trace_storage.h"

namespace perfetto::trace_processor {
class TraceProcessorContext;
}  // namespace perfetto::trace_processor

namespace perfetto::trace_processor::android_process_state {

// Tracks Android process identity across pid reuse.
//
// Android recycles pids aggressively, so a pid on its own does not identify a
// process. The framework stamps every process incarnation with a monotonic
// "start sequence id" and repeats it on the death event and in the
// AndroidProcessMetadata written at trace start. This class uses that id to
// decide when a pid has been recycled, and to find the right process when a
// death event arrives after the pid has already been handed to a new one.
//
// Used for every framework event that carries a start seq id, so the result
// does not depend on which packets are parsed first. Seq ids are only present
// with dump_process_metadata; ftrace traces never reach this class.
//
// Only a differing seq id proves two incarnations. A pid owner without one is
// adopted: it may be this very process. A process that started before the
// trace is closed by its death like any pid match, which also records its seq
// id. If its death arrives only after the pid was reused, nothing is ended.
//
// All state here lives only for the duration of parsing. Importers that want
// to expose it at query time must copy it into a table of their own.
class AndroidProcessTracker {
 public:
  explicit AndroidProcessTracker(TraceProcessorContext* context);
  ~AndroidProcessTracker();

  // Resolves the upid for an Android process incarnation.
  //
  // |start_ts| is set only for a process start event. A new process is
  // started if |pid| is currently owned by an incarnation with a different
  // start seq id. ProcessTracker::StartNewProcess() detaches
  // the pid from the previous incarnation and deliberately leaves it without
  // an end_ts: we know it is gone, but not when it died. That is recorded by
  // EndProcess() when the framework reports the death.
  //
  // android.util.proto.ProtoOutputStream omits zero-valued fields, so a
  // missing start_seq_id cannot be told apart from seq id 0. Records without
  // one are treated as belonging to the current owner of the pid.
  UniquePid GetOrStartProcess(std::optional<int64_t> start_ts,
                              int64_t pid,
                              std::optional<int64_t> start_seq_id,
                              StringId name);

  // Ends the incarnation (|pid|, |start_seq_id|) at |ts|, even if its pid has
  // since been handed to a newer incarnation. Returns the ended upid, or
  // nullopt if the incarnation cannot be identified: in that case nothing is
  // ended, as the only candidate would be a process that did not die.
  std::optional<UniquePid> EndProcess(int64_t ts,
                                      int64_t pid,
                                      int64_t start_seq_id);

  // Returns the start seq id of |upid|, if one has been seen.
  std::optional<int64_t> GetStartSeqId(UniquePid upid) const;

 private:
  bool IsSameIncarnation(UniquePid live_upid,
                         std::optional<int64_t> start_seq_id) const;
  std::optional<UniquePid> FindProcess(int64_t pid, int64_t start_seq_id) const;
  void Bind(UniquePid upid, int64_t start_seq_id);
  void RememberMainThread(UniquePid upid, int64_t pid);

  TraceProcessorContext* const context_;

  // start_seq_id -> upid. Entries are kept after a pid is recycled so that a
  // late death event can still find the process it refers to.
  base::FlatHashMap<int64_t, UniquePid> upid_by_seq_id_;

  // upid -> start_seq_id.
  base::FlatHashMap<UniquePid, int64_t> start_seq_id_by_upid_;

  // upid -> main thread, so that an incarnation which no longer owns its pid
  // can still have its main thread ended.
  base::FlatHashMap<UniquePid, UniqueTid> main_utid_by_upid_;
};

}  // namespace perfetto::trace_processor::android_process_state

#endif  // SRC_TRACE_PROCESSOR_PLUGINS_ANDROID_PROCESS_STATE_ANDROID_PROCESS_TRACKER_H_
