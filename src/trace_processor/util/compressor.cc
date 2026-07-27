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

#include "src/trace_processor/util/compression_types.h"
#include "src/trace_processor/util/gzip_compressor.h"
#include "src/trace_processor/util/zstd_compressor.h"

namespace perfetto::trace_processor::util {

std::optional<CompressedBuffer> CompressToBuffer(CompressionType type,
                                                 const uint8_t* data,
                                                 size_t len,
                                                 int level) {
  switch (type) {
    case CompressionType::kNone:
      return std::nullopt;
    case CompressionType::kGzip:
      if (!IsGzipSupported()) {
        return std::nullopt;
      }
      return GzipCompressor::CompressFully(data, len, level);
    case CompressionType::kZstd:
      if (!IsZstdSupported()) {
        return std::nullopt;
      }
      return ZstdCompressor::CompressFully(data, len, level);
  }
  return std::nullopt;
}

}  // namespace perfetto::trace_processor::util
