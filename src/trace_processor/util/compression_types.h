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

#ifndef SRC_TRACE_PROCESSOR_UTIL_COMPRESSION_TYPES_H_
#define SRC_TRACE_PROCESSOR_UTIL_COMPRESSION_TYPES_H_

#include <cstdint>

#include "perfetto/base/build_config.h"

namespace perfetto::trace_processor::util {

// The compression codecs trace_processor can compress and decompress. Shared by
// the compressor (compressor.h) and decompressor (decompressor.h) so neither
// side has to redefine the codec taxonomy, and so a caller can round-trip
// through the same enum. To add a codec, add a value here, handle it in both
// CreateDecompressor()/CompressToBuffer(), and (if it can arrive as a whole
// compressed file) add a magic in trace_type.cc's SniffCompressedTraceType()
// with a matching importer.
enum class CompressionType : uint8_t {
  // Not compressed, or a header we don't recognize.
  kNone,
  // gzip-framed deflate (e.g. a .gz file).
  kGzip,
  // A zstd frame.
  kZstd,
};

// Whether the current build flags include the library each codec needs.
// CreateDecompressor()/CompressToBuffer() return nothing for unsupported codecs.
constexpr bool IsGzipSupported() {
#if PERFETTO_BUILDFLAG(PERFETTO_ZLIB)
  return true;
#else
  return false;
#endif
}

constexpr bool IsZstdSupported() {
#if PERFETTO_BUILDFLAG(PERFETTO_ZSTD)
  return true;
#else
  return false;
#endif
}

}  // namespace perfetto::trace_processor::util

#endif  // SRC_TRACE_PROCESSOR_UTIL_COMPRESSION_TYPES_H_
