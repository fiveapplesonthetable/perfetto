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

#include "src/trace_processor/util/gzip_compressor.h"

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>

#include "perfetto/base/build_config.h"
#include "src/trace_processor/util/compressor.h"

#if PERFETTO_BUILDFLAG(PERFETTO_ZLIB)
#include <zlib.h>
#endif

namespace perfetto::trace_processor::util {

#if PERFETTO_BUILDFLAG(PERFETTO_ZLIB)

// static
std::optional<CompressedBuffer> GzipCompressor::CompressFully(
    const uint8_t* data,
    size_t len,
    int level) {
  z_stream zs{};
  // windowBits = 15 (max window) + 16 selects a gzip header/trailer, matching
  // what GzipDecompressor(InputMode::kGzip) expects. memLevel 8 is the default.
  if (deflateInit2(&zs, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) !=
      Z_OK) {
    return std::nullopt;
  }
  uLong bound = deflateBound(&zs, static_cast<uLong>(len));
  // zlib's avail_in/avail_out are 32-bit; a single-shot Z_FINISH needs the whole
  // input and its bound to fit. This is ample for any SQLite blob (< 2 GiB); an
  // over-large input is rejected rather than silently truncated.
  if (len > std::numeric_limits<uInt>::max() ||
      bound > std::numeric_limits<uInt>::max()) {
    deflateEnd(&zs);
    return std::nullopt;
  }
  CompressedBuffer out{std::unique_ptr<uint8_t[]>(new uint8_t[bound]), 0};
  zs.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(data));
  zs.avail_in = static_cast<uInt>(len);
  zs.next_out = reinterpret_cast<Bytef*>(out.data.get());
  zs.avail_out = static_cast<uInt>(bound);
  int ret = deflate(&zs, Z_FINISH);
  out.size = zs.total_out;
  deflateEnd(&zs);
  // deflateBound guarantees the output fit, so a full flush must reach the end.
  if (ret != Z_STREAM_END) {
    return std::nullopt;
  }
  return out;
}

#else  // !PERFETTO_ZLIB

// static
std::optional<CompressedBuffer> GzipCompressor::CompressFully(const uint8_t*,
                                                              size_t,
                                                              int) {
  return std::nullopt;
}

#endif  // PERFETTO_BUILDFLAG(PERFETTO_ZLIB)

}  // namespace perfetto::trace_processor::util
