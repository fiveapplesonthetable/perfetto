/*
 * Copyright (C) 2025 The Android Open Source Project
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

#include "src/android_sdk/perfetto_sdk_for_jni/tracing_sdk.h"

#include <sys/types.h>

#include <cstdarg>
#include <mutex>

#include "perfetto/public/abi/producer_abi.h"
#include "perfetto/public/producer.h"
#include "perfetto/public/te_macros.h"
#include "perfetto/public/track_event.h"

namespace perfetto {
namespace sdk_for_jni {
void register_perfetto(bool backend_in_process) {
  static std::once_flag registration;
  std::call_once(registration, [backend_in_process]() {
    struct PerfettoProducerInitArgs args = PERFETTO_PRODUCER_INIT_ARGS_INIT();
    args.backends = backend_in_process ? PERFETTO_BACKEND_IN_PROCESS
                                       : PERFETTO_BACKEND_SYSTEM;
    args.shmem_size_hint_kb = 1024;
    PerfettoProducerInit(args);
    PerfettoTeInit();
  });
}

void trace_event(int type,
                 const PerfettoTeCategory* perfettoTeCategory,
                 const char* name,
                 Extra* extra) {
  bool enabled = PERFETTO_UNLIKELY(PERFETTO_ATOMIC_LOAD_EXPLICIT(
      perfettoTeCategory->enabled, PERFETTO_MEMORY_ORDER_RELAXED));
  if (enabled) {
    extra->push_extra(nullptr);
    PerfettoTeHlEmitImpl(perfettoTeCategory->impl, type,
                         type == PERFETTO_TE_TYPE_COUNTER ? nullptr : name,
                         extra->get());
    extra->clear_extras();
  }
}

uint64_t get_process_track_uuid() {
  return PerfettoTeProcessTrackUuid();
}

uint64_t get_thread_track_uuid(pid_t tid) {
  // Cating a signed pid_t to unsigned
  return PerfettoTeProcessTrackUuid() ^ PERFETTO_STATIC_CAST(uint64_t, tid);
}

Extra::Extra() {}

void Extra::push_extra(PerfettoTeHlExtra* ptr) {
  extras_.push_back(ptr);
}

void Extra::pop_extra() {
  extras_.pop_back();
}

void Extra::clear_extras() {
  extras_.clear();
}

void Extra::delete_extra(Extra* ptr) {
  delete ptr;
}

Category::Category(const std::string& name) : Category(name, {}) {}

Category::Category(const std::string& name,
                   const std::vector<std::string>& tags)
    : category_({&perfetto_atomic_false, {}, {}, 0}), name_(name), tags_(tags) {
  for (const auto& tag : tags_) {
    tags_data_.push_back(tag.data());
  }
}

Category::~Category() {
  unregister_category();
}

void Category::register_category() {
  if (category_.impl)
    return;

  category_.desc = {name_.c_str(), name_.c_str(), tags_data_.data(),
                    tags_data_.size()};

  PerfettoTeCategoryRegister(&category_);
  PerfettoTePublishCategories();
}

void Category::unregister_category() {
  if (!category_.impl)
    return;

  PerfettoTeCategoryUnregister(&category_);
  PerfettoTePublishCategories();
}

bool Category::is_category_enabled() {
  return PERFETTO_UNLIKELY(PERFETTO_ATOMIC_LOAD_EXPLICIT(
      (category_).enabled, PERFETTO_MEMORY_ORDER_RELAXED));
}

void Category::delete_category(Category* ptr) {
  delete ptr;
}

NestedTracks::NestedTracks(int root_type,
                           uint64_t tid,
                           const std::vector<std::string>& names,
                           const std::vector<uint64_t>& ids,
                           const std::vector<bool>& is_name_static,
                           const std::vector<bool>& is_counter)
    : names_(names), root_thread_{}, root_other_{} {
  const size_t count = names_.size();
  named_.reserve(count);
  ptrs_.reserve(count + 2);

  // Outermost entry: the root scope. Global roots have none (the first named
  // level then hangs off uuid 0).
  if (root_type == 1 /* process */) {
    root_other_.type = PERFETTO_TE_HL_NESTED_TRACK_TYPE_PROCESS;
    ptrs_.push_back(&root_other_);
  } else if (root_type == 2 /* thread */) {
    root_thread_.header.type = PERFETTO_TE_HL_NESTED_TRACK_TYPE_THREAD;
    root_thread_.tid = tid;
    ptrs_.push_back(&root_thread_.header);
  }

  for (size_t i = 0; i < count; i++) {
    PerfettoTeHlNestedTrackNamed entry{};
    entry.header.type = PERFETTO_TE_HL_NESTED_TRACK_TYPE_NAMED;
    entry.name = names_[i].c_str();
    entry.id = ids[i];
    entry.is_name_static = i < is_name_static.size() ? is_name_static[i] : false;
    entry.is_counter = i < is_counter.size() ? is_counter[i] : false;
    named_.push_back(entry);
  }
  for (size_t i = 0; i < count; i++) {
    ptrs_.push_back(reinterpret_cast<PerfettoTeHlNestedTrack*>(&named_[i]));
  }
  ptrs_.push_back(nullptr);

  extra_.header.type = PERFETTO_TE_HL_EXTRA_TYPE_NESTED_TRACKS;
  extra_.tracks = ptrs_.data();
}

void NestedTracks::delete_track(NestedTracks* ptr) {
  delete ptr;
}

Session::Session(bool is_backend_in_process, void* buf, size_t len) {
  session_ = PerfettoTracingSessionCreate(is_backend_in_process
                                              ? PERFETTO_BACKEND_IN_PROCESS
                                              : PERFETTO_BACKEND_SYSTEM);

  PerfettoTracingSessionSetup(session_, buf, len);

  PerfettoTracingSessionStartBlocking(session_);
}

Session::~Session() {
  PerfettoTracingSessionStopBlocking(session_);
  PerfettoTracingSessionDestroy(session_);
}

bool Session::FlushBlocking(uint32_t timeout_ms) {
  return PerfettoTracingSessionFlushBlocking(session_, timeout_ms);
}

void Session::StopBlocking() {
  PerfettoTracingSessionStopBlocking(session_);
}

std::vector<uint8_t> Session::ReadBlocking() {
  std::vector<uint8_t> data;
  PerfettoTracingSessionReadTraceBlocking(
      session_,
      [](struct PerfettoTracingSessionImpl*, const void* trace_data,
         size_t size, bool, void* user_arg) {
        auto& dst = *static_cast<std::vector<uint8_t>*>(user_arg);
        auto* src = static_cast<const uint8_t*>(trace_data);
        dst.insert(dst.end(), src, src + size);
      },
      &data);
  return data;
}

void Session::delete_session(Session* ptr) {
  delete ptr;
}

void activate_trigger(const char* name, uint32_t ttl_ms) {
  const char* names[] = {name, nullptr};
  PerfettoProducerActivateTriggers(names, ttl_ms);
}
}  // namespace sdk_for_jni
}  // namespace perfetto
