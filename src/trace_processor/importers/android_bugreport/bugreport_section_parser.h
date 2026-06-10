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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_SECTION_PARSER_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_SECTION_PARSER_H_

#include <cstdint>
#include <memory>
#include <vector>

#include "perfetto/base/status.h"
#include "perfetto/ext/base/string_view.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

namespace android_bugreport {

struct BugreportFormat;
class BugreportTimelineEmitter;

// Dependencies handed to every section parser.
struct BugreportParserDeps {
  TraceProcessorContext* context;
  const BugreportFormat* format;
  BugreportTimelineEmitter* emitter;
  // The dumpstate section name / dumpsys service name being parsed. Lets
  // generic parsers registered for many sections (e.g. the catch-all event
  // log parser) label their output per section.
  std::string name;
};

// Interface for parsers that extract structured / timeline data from one
// dumpstate section (e.g. "KERNEL LOG") or one dumpsys service dump (e.g.
// "DUMP OF SERVICE jobscheduler:").
//
// A new parser instance is created each time its section starts and receives
// every line of the section body. Parsers must be tolerant of missing
// sub-sections: e.g. the "activity" parser is also instantiated for the
// abbreviated "DUMP OF SERVICE CRITICAL activity:" dump, where most
// sub-sections are absent.
class BugreportSectionParser {
 public:
  virtual ~BugreportSectionParser();

  virtual base::Status ParseLine(base::StringView line) = 0;

  // Invoked when the section ends (next section starts or end of file).
  virtual base::Status EndOfSection();
};

// Static registry of section parsers. To add support for a new section, or a
// new format version of an existing section, add an entry to the table in
// bugreport_parser_registry.cc.
struct BugreportParserRegistration {
  enum class Target {
    kSection,        // Matches dumpstate section names by prefix.
    kDumpsysService  // Matches dumpsys service names exactly.
  };

  Target target;
  // For kSection: matched as a prefix of the section name. For
  // kDumpsysService: matched exactly, or "*" to match every service (used
  // by the catch-all parser for the standard Android event-log idioms).
  const char* name;

  // SDK version (i.e. Android release) bounds for this parser, both
  // inclusive; 0 means unbounded. When a dump format drifts in release N,
  // cap the old parser at max_sdk = N - 1 and register the new parser with
  // min_sdk = N. Bugreports with an unparseable SDK version (0) match only
  // entries with min_sdk == 0.
  int32_t min_sdk;
  int32_t max_sdk;

  std::unique_ptr<BugreportSectionParser> (*factory)(
      const BugreportParserDeps& deps);
};

class BugreportParserRegistry {
 public:
  // Returns the parsers registered for the given section/service that match
  // the bugreport's SDK version (empty if none). A section can have multiple
  // parsers, each extracting different data (e.g. "activity" has separate
  // broadcast-history and process-state parsers).
  static std::vector<std::unique_ptr<BugreportSectionParser>> Create(
      BugreportParserRegistration::Target target,
      base::StringView name,
      const BugreportParserDeps& deps);
};

}  // namespace android_bugreport
}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_SECTION_PARSER_H_
