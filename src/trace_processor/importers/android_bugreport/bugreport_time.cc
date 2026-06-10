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

#include <cstddef>
#include <cstdint>
#include <optional>

#include "perfetto/base/time.h"
#include "perfetto/ext/base/string_view.h"

namespace perfetto::trace_processor::android_bugreport {

namespace {

// Reads digits from `sv` starting at `*pos`, advancing `*pos` past them.
// Returns nullopt if there is not a single digit at `*pos`.
std::optional<int64_t> ReadInt(base::StringView sv, size_t* pos) {
  int64_t num = 0;
  size_t i = *pos;
  for (; i < sv.size() && sv.at(i) >= '0' && sv.at(i) <= '9'; ++i) {
    num = num * 10 + (sv.at(i) - '0');
  }
  if (i == *pos)
    return std::nullopt;
  *pos = i;
  return num;
}

// Expects character `c` at `*pos` and advances past it.
bool Expect(base::StringView sv, size_t* pos, char c) {
  if (*pos >= sv.size() || sv.at(*pos) != c)
    return false;
  ++*pos;
  return true;
}

}  // namespace

std::optional<int64_t> ParseIsoDateTimeMs(base::StringView sv) {
  // "2026-06-10 09:21:16" or "2026-06-10 09:21:16.123".
  size_t pos = 0;
  auto year = ReadInt(sv, &pos);
  if (!year || !Expect(sv, &pos, '-'))
    return std::nullopt;
  auto month = ReadInt(sv, &pos);
  if (!month || !Expect(sv, &pos, '-'))
    return std::nullopt;
  auto day = ReadInt(sv, &pos);
  if (!day || !Expect(sv, &pos, ' '))
    return std::nullopt;
  auto hour = ReadInt(sv, &pos);
  if (!hour || !Expect(sv, &pos, ':'))
    return std::nullopt;
  auto minute = ReadInt(sv, &pos);
  if (!minute || !Expect(sv, &pos, ':'))
    return std::nullopt;
  auto sec = ReadInt(sv, &pos);
  if (!sec)
    return std::nullopt;

  int64_t ms = 0;
  if (pos < sv.size() && sv.at(pos) == '.') {
    ++pos;
    // Parse up to 3 fractional digits as milliseconds ("4" -> 400ms).
    int64_t frac = 0;
    int digits = 0;
    while (pos < sv.size() && digits < 3 && sv.at(pos) >= '0' &&
           sv.at(pos) <= '9') {
      frac = frac * 10 + (sv.at(pos) - '0');
      ++digits;
      ++pos;
    }
    if (digits == 0)
      return std::nullopt;
    for (; digits < 3; ++digits)
      frac *= 10;
    ms = frac;
  }

  int64_t secs =
      base::MkTime(static_cast<int>(*year), static_cast<int>(*month),
                   static_cast<int>(*day), static_cast<int>(*hour),
                   static_cast<int>(*minute), static_cast<int>(*sec));
  return secs * 1000 + ms;
}

std::optional<int64_t> ParseAndroidDurationMs(base::StringView sv) {
  // As printed by android.util.TimeUtils.formatDuration():
  //   "+1d0h3m4s5ms", "-1h2m3s4ms", "+5s0ms", "-41ms", "0".
  if (sv.empty())
    return std::nullopt;
  if (sv == "0")
    return 0;

  size_t pos = 0;
  int64_t sign = 1;
  if (sv.at(0) == '-') {
    sign = -1;
    pos = 1;
  } else if (sv.at(0) == '+') {
    pos = 1;
  }

  int64_t total_ms = 0;
  bool any_unit = false;
  while (pos < sv.size()) {
    auto num = ReadInt(sv, &pos);
    if (!num)
      break;
    if (pos + 1 < sv.size() && sv.at(pos) == 'm' && sv.at(pos + 1) == 's') {
      total_ms += *num;
      pos += 2;
    } else if (pos < sv.size() && sv.at(pos) == 'd') {
      total_ms += *num * 86400000;
      ++pos;
    } else if (pos < sv.size() && sv.at(pos) == 'h') {
      total_ms += *num * 3600000;
      ++pos;
    } else if (pos < sv.size() && sv.at(pos) == 'm') {
      total_ms += *num * 60000;
      ++pos;
    } else if (pos < sv.size() && sv.at(pos) == 's') {
      total_ms += *num * 1000;
      ++pos;
    } else {
      return std::nullopt;
    }
    any_unit = true;
  }
  if (!any_unit)
    return std::nullopt;
  return sign * total_ms;
}

}  // namespace perfetto::trace_processor::android_bugreport
