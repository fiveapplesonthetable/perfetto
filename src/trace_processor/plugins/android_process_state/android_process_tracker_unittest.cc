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
#include <memory>
#include <optional>

#include "src/trace_processor/importers/common/event_tracker.h"
#include "src/trace_processor/importers/common/global_args_tracker.h"
#include "src/trace_processor/importers/common/global_stats_tracker.h"
#include "src/trace_processor/importers/common/import_logs_tracker.h"
#include "src/trace_processor/importers/common/machine_tracker.h"
#include "src/trace_processor/importers/common/process_tracker.h"
#include "src/trace_processor/importers/common/stats_tracker.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"
#include "test/gtest_and_gmock.h"

namespace perfetto::trace_processor::android_process_state {
namespace {

class AndroidProcessTrackerTest : public ::testing::Test {
 public:
  AndroidProcessTrackerTest() {
    context_.storage = std::make_unique<TraceStorage>();
    context_.global_stats_tracker =
        std::make_unique<GlobalStatsTracker>(context_.storage.get());
    context_.global_args_tracker =
        std::make_unique<GlobalArgsTracker>(context_.storage.get());
    context_.machine_tracker =
        std::make_unique<MachineTracker>(&context_, kDefaultMachineId);
    context_.trace_state =
        TraceProcessorContextPtr<TraceProcessorContext::TraceState>::MakeRoot(
            TraceProcessorContext::TraceState{TraceId{0}});
    context_.stats_tracker = std::make_unique<StatsTracker>(&context_);
    context_.import_logs_tracker.reset(
        new ImportLogsTracker(&context_, TraceId{1}));
    context_.process_tracker = std::make_unique<ProcessTracker>(&context_);
    context_.event_tracker = std::make_unique<EventTracker>(&context_);
    tracker_ = std::make_unique<AndroidProcessTracker>(&context_);
  }

 protected:
  StringId Str(const char* s) { return context_.storage->InternString(s); }
  auto Process(UniquePid upid) {
    return context_.storage->process_table()[upid];
  }
  std::optional<int64_t> MainThreadEnd(UniquePid upid) {
    const auto& threads = context_.storage->thread_table();
    for (uint32_t i = 0; i < threads.row_count(); ++i) {
      auto t = threads[i];
      if (t.upid() == upid && t.is_main_thread().value_or(false)) {
        return t.end_ts();
      }
    }
    return std::nullopt;
  }

  TraceProcessorContext context_;
  std::unique_ptr<AndroidProcessTracker> tracker_;
};

TEST_F(AndroidProcessTrackerTest, SameSeqIdResolvesToSameProcess) {
  UniquePid a = tracker_->GetOrStartProcess(100, 10, 1, Str("app"));
  EXPECT_EQ(tracker_->GetOrStartProcess(std::nullopt, 10, 1, Str("app")), a);
  EXPECT_EQ(tracker_->GetStartSeqId(a), 1);
  EXPECT_EQ(Process(a).start_ts(), 100);
  EXPECT_EQ(Process(a).name(), Str("app"));
}

TEST_F(AndroidProcessTrackerTest, NewSeqIdOnSamePidStartsNewProcess) {
  UniquePid a = tracker_->GetOrStartProcess(100, 10, 1, Str("a"));
  UniquePid b = tracker_->GetOrStartProcess(200, 10, 2, Str("b"));
  EXPECT_NE(a, b);
  EXPECT_EQ(context_.process_tracker->GetProcessOrNull(10), b);
  // A new incarnation says the old one is gone, not when: no end_ts yet.
  EXPECT_FALSE(Process(a).end_ts().has_value());
  EXPECT_EQ(Process(a).name(), Str("a"));
  EXPECT_EQ(Process(b).name(), Str("b"));
}

TEST_F(AndroidProcessTrackerTest, LateEventForOldIncarnationKeepsNewOwner) {
  UniquePid a = tracker_->GetOrStartProcess(100, 10, 1, Str("a"));
  UniquePid b = tracker_->GetOrStartProcess(200, 10, 2, Str("b"));
  EXPECT_EQ(tracker_->GetOrStartProcess(std::nullopt, 10, 1, Str("a")), a);
  EXPECT_EQ(context_.process_tracker->GetProcessOrNull(10), b);
}

TEST_F(AndroidProcessTrackerTest, LateDeathEndsDiedIncarnationOnly) {
  UniquePid a = tracker_->GetOrStartProcess(100, 10, 1, Str("a"));
  UniquePid b = tracker_->GetOrStartProcess(200, 10, 2, Str("b"));
  EXPECT_EQ(tracker_->EndProcess(300, 10, 1), a);
  EXPECT_EQ(Process(a).end_ts(), 300);
  EXPECT_EQ(MainThreadEnd(a), 300);
  EXPECT_FALSE(Process(b).end_ts().has_value());
  EXPECT_EQ(context_.process_tracker->GetProcessOrNull(10), b);

  EXPECT_EQ(tracker_->EndProcess(400, 10, 2), b);
  EXPECT_EQ(Process(b).end_ts(), 400);
  EXPECT_EQ(MainThreadEnd(b), 400);
  EXPECT_FALSE(context_.process_tracker->GetProcessOrNull(10).has_value());
}

TEST_F(AndroidProcessTrackerTest, OwnerWithoutSeqIdIsAdoptedByDump) {
  UniquePid live = context_.process_tracker->GetOrCreateProcess(10);
  EXPECT_EQ(tracker_->GetOrStartProcess(std::nullopt, 10, 5, Str("app")), live);
  EXPECT_EQ(tracker_->GetStartSeqId(live), 5);
}

TEST_F(AndroidProcessTrackerTest, StartWithSameNameAdoptsOwner) {
  UniquePid live = context_.process_tracker->GetOrCreateProcess(10);
  context_.process_tracker->UpdateProcessName(
      live, Str("app"), ProcessNamePriority::kTrackDescriptor);
  EXPECT_EQ(tracker_->GetOrStartProcess(100, 10, 5, Str("app")), live);
}

TEST_F(AndroidProcessTrackerTest, PreTraceOwnerIsSplitAndEndedByLateDeath) {
  // Running before the trace: no start, known only by name.
  UniquePid old = context_.process_tracker->GetOrCreateProcess(10);
  context_.process_tracker->UpdateProcessName(
      old, Str("a"), ProcessNamePriority::kTrackDescriptor);

  UniquePid b = tracker_->GetOrStartProcess(200, 10, 2, Str("b"));
  EXPECT_NE(b, old);

  EXPECT_EQ(tracker_->EndProcess(300, 10, 1), old);
  EXPECT_EQ(Process(old).end_ts(), 300);
  EXPECT_EQ(tracker_->GetStartSeqId(old), 1);
  EXPECT_FALSE(Process(b).end_ts().has_value());
}

TEST_F(AndroidProcessTrackerTest, UnknownDeathNeverEndsKnownOwner) {
  UniquePid a = tracker_->GetOrStartProcess(100, 10, 1, Str("a"));
  UniquePid b = tracker_->GetOrStartProcess(200, 10, 2, Str("b"));
  ASSERT_EQ(tracker_->EndProcess(250, 10, 1), a);
  // seq 7 was never seen and the only displaced incarnation already has a seq
  // id: nothing can be safely ended.
  EXPECT_FALSE(tracker_->EndProcess(300, 10, 7).has_value());
  EXPECT_FALSE(Process(b).end_ts().has_value());
}

TEST_F(AndroidProcessTrackerTest, OwnerWithoutMainThreadStillEnds) {
  UniquePid live =
      context_.process_tracker->GetOrCreateProcessWithoutMainThread(10);
  EXPECT_EQ(tracker_->EndProcess(300, 10, 1), live);
  EXPECT_EQ(Process(live).end_ts(), 300);
}

TEST_F(AndroidProcessTrackerTest, SeqIdIsCheckedAgainstPid) {
  tracker_->GetOrStartProcess(100, 10, 1, Str("a"));
  UniquePid other = tracker_->GetOrStartProcess(100, 20, 1, Str("x"));
  EXPECT_EQ(Process(other).pid(), 20);
}

}  // namespace
}  // namespace perfetto::trace_processor::android_process_state
