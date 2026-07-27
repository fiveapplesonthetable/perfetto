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

#ifndef SRC_TRACE_PROCESSOR_UTIL_GZIP_COMPRESSOR_H_
#define SRC_TRACE_PROCESSOR_UTIL_GZIP_COMPRESSOR_H_

#include <cstddef>
#include <cstdint>
#include <optional>

#include "src/trace_processor/util/compressor.h"

namespace perfetto::trace_processor::util {

// One-shot gzip compression, the counterpart of GzipDecompressor. Prefer the
// codec-agnostic CompressToBuffer(CompressionType::kGzip, ...); use this
// directly only when a gzip member is specifically required.
struct GzipCompressor {
  // Compresses |data| into a single gzip member at |level| (0-9) that
  // GzipDecompressor (InputMode::kGzip) reads back. Returns nullopt on error or
  // when zlib is not compiled in (IsGzipSupported()).
  static std::optional<CompressedBuffer> CompressFully(const uint8_t* data,
                                                       size_t len,
                                                       int level);
};

}  // namespace perfetto::trace_processor::util

#endif  // SRC_TRACE_PROCESSOR_UTIL_GZIP_COMPRESSOR_H_
