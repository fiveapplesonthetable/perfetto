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

#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"

#include <cstdint>
#include <optional>

#include "perfetto/ext/base/string_utils.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_time.h"
#include "src/trace_processor/importers/common/metadata_tracker.h"
#include "src/trace_processor/storage/metadata.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"
#include "src/trace_processor/types/variadic.h"

namespace perfetto::trace_processor::android_bugreport {

BugreportFormatParser::BugreportFormatParser(TraceProcessorContext* context)
    : context_(context) {}

bool BugreportFormatParser::ParseLine(base::StringView line) {
  if (line.StartsWith("== dumpstate: ")) {
    format_.dumpstate_start_ms =
        ParseIsoDateTimeMs(line.substr(strlen("== dumpstate: ")));
    return true;
  }
  if (line.StartsWith("Build: ")) {
    format_.build = line.substr(strlen("Build: ")).ToStdString();
    return true;
  }
  if (line.StartsWith("Build fingerprint: ")) {
    base::StringView fp = line.substr(strlen("Build fingerprint: "));
    // Strip the surrounding single quotes.
    if (fp.size() >= 2 && fp.at(0) == '\'' && fp.at(fp.size() - 1) == '\'') {
      fp = fp.substr(1, fp.size() - 2);
    }
    format_.build_fingerprint = fp.ToStdString();
    return true;
  }
  if (line.StartsWith("Android SDK version: ")) {
    std::optional<int32_t> sdk =
        base::StringViewToInt32(line.substr(strlen("Android SDK version: ")));
    format_.sdk_version = sdk.value_or(0);
    return true;
  }
  return false;
}

void BugreportFormatParser::Finalize() {
  auto* metadata = context_->metadata_tracker.get();
  if (!format_.build_fingerprint.empty()) {
    metadata->SetMetadata(metadata::android_build_fingerprint,
                          Variadic::String(context_->storage->InternString(
                              base::StringView(format_.build_fingerprint))));
  }
  if (format_.sdk_version != 0) {
    metadata->SetMetadata(metadata::android_sdk_version,
                          Variadic::Integer(format_.sdk_version));
  }
}

}  // namespace perfetto::trace_processor::android_bugreport
