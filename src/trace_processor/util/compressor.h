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

#ifndef SRC_TRACE_PROCESSOR_UTIL_COMPRESSOR_H_
#define SRC_TRACE_PROCESSOR_UTIL_COMPRESSOR_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>

#include "src/trace_processor/util/compression_types.h"

namespace perfetto::trace_processor::util {

// An owned block of compressed bytes. The allocation may be larger than `size`,
// so only `size` bytes are valid. Mirrors DecompressedBuffer so a caller can
// hand it straight to a zero-copy sink (e.g. SQLite result::RawBytes).
struct CompressedBuffer {
  std::unique_ptr<uint8_t[]> data;
  size_t size = 0;
};

// Compresses an entire in-memory block into one owned heap buffer, framed for
// `type` so DecompressToBuffer() with the same type round-trips it (a single
// gzip member for kGzip, a single zstd frame for kZstd). `level` is the codec's
// own native scale (zlib 0-9, zstd 1-22); pass a level that suits the data.
//
// Returns nullopt if `type` is kNone, the codec is not compiled into this build
// (see IsGzipSupported()/IsZstdSupported()), or the codec reports an error.
//
// This is the one-shot, whole-buffer counterpart of CreateDecompressor(); for
// incremental/streaming compression of a live trace, the tracing service has
// its own packet-oriented compressor (src/tracing/service), which is a
// different shape and deliberately not shared here.
std::optional<CompressedBuffer> CompressToBuffer(CompressionType type,
                                                 const uint8_t* data,
                                                 size_t len,
                                                 int level);

}  // namespace perfetto::trace_processor::util

#endif  // SRC_TRACE_PROCESSOR_UTIL_COMPRESSOR_H_
