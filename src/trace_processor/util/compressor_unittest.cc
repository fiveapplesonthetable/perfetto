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

#include "src/trace_processor/util/compressor.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "src/trace_processor/util/compression_types.h"
#include "src/trace_processor/util/decompressor.h"
#include "test/gtest_and_gmock.h"

namespace perfetto::trace_processor::util {
namespace {

// Compresses `input` with `type`/`level`, then decompresses it with the same
// codec via the decompressor. Returns the round-tripped bytes, or nullopt if
// either step failed.
std::optional<std::string> RoundTrip(CompressionType type,
                                     const std::string& input,
                                     int level) {
  auto compressed =
      CompressToBuffer(type, reinterpret_cast<const uint8_t*>(input.data()),
                       input.size(), level);
  if (!compressed) {
    return std::nullopt;
  }
  auto decompressed =
      DecompressToBuffer(type, compressed->data.get(), compressed->size);
  if (!decompressed) {
    return std::nullopt;
  }
  return std::string(reinterpret_cast<const char*>(decompressed->data.get()),
                     decompressed->size);
}

// A mix of repetition (compressible) and variety, ~1 KB.
std::string SampleText() {
  std::string s;
  for (int i = 0; i < 40; i++) {
    s += "the quick brown fox jumps over the lazy dog 0123456789 ";
  }
  return s;
}

TEST(CompressorTest, GzipRoundTrip) {
  if (!IsGzipSupported()) {
    GTEST_SKIP() << "zlib not compiled in";
  }
  std::string input = SampleText();
  auto out = RoundTrip(CompressionType::kGzip, input, 6);
  ASSERT_TRUE(out.has_value());
  EXPECT_EQ(*out, input);
}

TEST(CompressorTest, ZstdRoundTrip) {
  if (!IsZstdSupported()) {
    GTEST_SKIP() << "zstd not compiled in";
  }
  std::string input = SampleText();
  auto out = RoundTrip(CompressionType::kZstd, input, 9);
  ASSERT_TRUE(out.has_value());
  EXPECT_EQ(*out, input);
}

TEST(CompressorTest, EmptyRoundTrips) {
  if (IsGzipSupported()) {
    auto out = RoundTrip(CompressionType::kGzip, "", 6);
    ASSERT_TRUE(out.has_value());
    EXPECT_EQ(*out, "");
  }
  if (IsZstdSupported()) {
    auto out = RoundTrip(CompressionType::kZstd, "", 9);
    ASSERT_TRUE(out.has_value());
    EXPECT_EQ(*out, "");
  }
}

TEST(CompressorTest, ActuallyShrinksCompressibleInput) {
  std::string input(16 * 1024, 'a');
  for (CompressionType type :
       {CompressionType::kGzip, CompressionType::kZstd}) {
    if (!IsCompressionSupported(type)) {
      continue;
    }
    auto compressed =
        CompressToBuffer(type, reinterpret_cast<const uint8_t*>(input.data()),
                         input.size(), /*level=*/6);
    ASSERT_TRUE(compressed.has_value());
    EXPECT_LT(compressed->size, input.size());
  }
}

TEST(CompressorTest, NoneIsNullopt) {
  uint8_t byte = 0;
  EXPECT_FALSE(
      CompressToBuffer(CompressionType::kNone, &byte, 1, /*level=*/1)
          .has_value());
}

}  // namespace
}  // namespace perfetto::trace_processor::util
