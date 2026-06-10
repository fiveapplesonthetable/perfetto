/*
 * Copyright (C) 2022 The Android Open Source Project
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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_ANDROID_DUMPSTATE_READER_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_ANDROID_DUMPSTATE_READER_H_

#include "src/trace_processor/importers/android_bugreport/android_battery_stats_reader.h"
#include "src/trace_processor/importers/android_bugreport/android_log_reader.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_timeline_emitter.h"
#include "src/trace_processor/importers/android_bugreport/chunked_line_reader.h"
#include "src/trace_processor/storage/trace_storage.h"

namespace perfetto::trace_processor {

class TraceProcessorContext;

// Trace importer for Android dumpstate files.
class AndroidDumpstateReader : public ChunkedLineReader {
 public:
  // Create a reader that will only forward events that are not present in the
  // given list.
  AndroidDumpstateReader(TraceProcessorContext* context);
  ~AndroidDumpstateReader() override;

  base::Status ParseLine(base::StringView line) override;
  void EndOfStream(base::StringView leftovers) override;

  base::Status ParseLine(BufferingAndroidLogReader* const log_reader,
                         base::StringView line);

  // Ingestion of auxiliary text files from the bugreport zip (FS/proc/*,
  // FS/data/anr/*, dumpstate_log.txt, ...): lines land in the
  // android_dumpstate table with section = file path; ANR / tombstone files
  // additionally go through the stack-dump parser.
  void StartAuxiliaryFile(const std::string& name);
  base::Status ParseAuxiliaryFileLine(base::StringView line);
  void FinishAuxiliaryFiles();

 protected:
  void MaybeSetTzOffsetFromAlarmService(base::StringView line);

 private:
  enum class Section {
    kOther = 0,
    kDumpsys,
    kLog,
    // Log sections whose content may duplicate earlier log sections (e.g.
    // KERNEL LOG, whose lines also show up in SYSTEM LOG on devices where
    // logcat includes the kernel buffer). Parsed through a deduplicating
    // reader.
    kDedupLog,
    kBatteryStats
  };

  void SwitchSectionParser(
      android_bugreport::BugreportParserRegistration::Target target,
      base::StringView name);

  TraceProcessorContext* const context_;
  AndroidBatteryStatsReader battery_stats_reader_;
  std::unique_ptr<BufferingAndroidLogReader> default_log_reader_;
  std::unique_ptr<DedupingAndroidLogReader> dedup_log_reader_;
  Section current_section_ = Section::kOther;
  base::StringView current_service_ = "";
  StringId current_section_id_ = StringId::Null();
  StringId current_service_id_ = StringId::Null();

  // Bugreport section-parser framework (see bugreport_section_parser.h).
  bool in_preamble_ = true;
  android_bugreport::BugreportFormatParser format_parser_;
  android_bugreport::BugreportTimelineEmitter timeline_emitter_;
  std::vector<std::unique_ptr<android_bugreport::BugreportSectionParser>>
      current_section_parsers_;

  // State for auxiliary zip file ingestion.
  StringId aux_section_id_ = StringId::Null();
  std::unique_ptr<android_bugreport::BugreportSectionParser> aux_parser_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_ANDROID_DUMPSTATE_READER_H_
