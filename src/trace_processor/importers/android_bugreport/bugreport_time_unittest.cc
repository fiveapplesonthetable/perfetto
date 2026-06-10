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

#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"

#include <cstdint>

#include "perfetto/base/time.h"
#include "test/gtest_and_gmock.h"

namespace perfetto::trace_processor::android_bugreport {
namespace {

TEST(BugreportTimeTest, ParseIsoDateTimeMs) {
  int64_t expected = base::MkTime(2026, 6, 10, 9, 21, 16) * 1000;
  EXPECT_EQ(ParseIsoDateTimeMs("2026-06-10 09:21:16"), expected);
  EXPECT_EQ(ParseIsoDateTimeMs("2026-06-10 09:21:16.123"), expected + 123);
  // Fewer than 3 fractional digits scale up; extra digits are ignored.
  EXPECT_EQ(ParseIsoDateTimeMs("2026-06-10 09:21:16.4"), expected + 400);
  EXPECT_EQ(ParseIsoDateTimeMs("2026-06-10 09:21:16.123456"), expected + 123);

  EXPECT_FALSE(ParseIsoDateTimeMs("not a date").has_value());
  EXPECT_FALSE(ParseIsoDateTimeMs("2026-06-10").has_value());
  EXPECT_FALSE(ParseIsoDateTimeMs("2026-06-10 09:21").has_value());
  EXPECT_FALSE(ParseIsoDateTimeMs("").has_value());
}

TEST(BugreportTimeTest, ParseAndroidDurationMs) {
  EXPECT_EQ(ParseAndroidDurationMs("0"), 0);
  EXPECT_EQ(ParseAndroidDurationMs("+41ms"), 41);
  EXPECT_EQ(ParseAndroidDurationMs("-41ms"), -41);
  EXPECT_EQ(ParseAndroidDurationMs("+5s0ms"), 5000);
  EXPECT_EQ(ParseAndroidDurationMs("-19m40s688ms"), -(19 * 60000 + 40688));
  EXPECT_EQ(ParseAndroidDurationMs("+1d0h3m4s5ms"),
            86400000 + 3 * 60000 + 4005);
  EXPECT_EQ(ParseAndroidDurationMs("+1h2m3s4ms"), 3600000 + 2 * 60000 + 3004);
  // Bare units without sign (used by some services).
  EXPECT_EQ(ParseAndroidDurationMs("1h32m"), 3600000 + 32 * 60000);

  EXPECT_FALSE(ParseAndroidDurationMs("").has_value());
  EXPECT_FALSE(ParseAndroidDurationMs("abc").has_value());
  EXPECT_FALSE(ParseAndroidDurationMs("+12").has_value());
}

}  // namespace
}  // namespace perfetto::trace_processor::android_bugreport
