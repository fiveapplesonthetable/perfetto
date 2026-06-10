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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_PARSERS_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_PARSERS_H_

#include <memory>

#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"

// Factory functions for all registered bugreport section parsers. Each lives
// in its own dumpsys_*_parser.cc / dumpstate_*_parser.cc file; they are tied
// together by the table in bugreport_parser_registry.cc.

namespace perfetto::trace_processor::android_bugreport {

// "DUMP OF SERVICE dropbox:": drop box entry list -> instants.
std::unique_ptr<BugreportSectionParser> CreateDumpsysDropboxParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE jobscheduler:": "Job history:" -> job slices.
std::unique_ptr<BugreportSectionParser> CreateDumpsysJobSchedulerParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE activity:": "Historical broadcasts" -> broadcast slices.
std::unique_ptr<BugreportSectionParser> CreateDumpsysBroadcastsParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE usagestats:": daily event log -> app lifecycle instants.
std::unique_ptr<BugreportSectionParser> CreateDumpsysUsageStatsParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE appops:": per-package op "Access:" entries -> instants
// and slices.
std::unique_ptr<BugreportSectionParser> CreateDumpsysAppOpsParser(
    const BugreportParserDeps& deps);

// Catch-all for every dumpsys service: StateMachine "rec[N]:" records,
// android.util.LocalLog lines, EventLogger blocks and bare timestamped
// lines -> instants on a per-service track.
std::unique_ptr<BugreportSectionParser> CreateDumpsysEventLogParser(
    const BugreportParserDeps& deps);

// Same idioms for the "APP SERVICES *" / "APP PROVIDERS *" dumpstate
// sections, attributed per app-service component.
std::unique_ptr<BugreportSectionParser> CreateAppServicesEventLogParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE settings:": historical setting mutations.
std::unique_ptr<BugreportSectionParser> CreateDumpsysSettingsParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE app_hibernation:": per-package unhibernation times.
std::unique_ptr<BugreportSectionParser> CreateDumpsysAppHibernationParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE package:": package install/update times.
std::unique_ptr<BugreportSectionParser> CreateDumpsysPackageParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE input:": InputDispatcher key/motion event queues.
std::unique_ptr<BugreportSectionParser> CreateDumpsysInputParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE input_method:": ImeTracker / StartInput history.
std::unique_ptr<BugreportSectionParser> CreateDumpsysInputMethodParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE bluetooth_manager:": enable log + GATT event logs.
std::unique_ptr<BugreportSectionParser> CreateDumpsysBluetoothManagerParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE connmetrics:": connectivity metrics events.
std::unique_ptr<BugreportSectionParser> CreateDumpsysConnMetricsParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE dbinfo:": per-database recent operation logs.
std::unique_ptr<BugreportSectionParser> CreateDumpsysDbinfoParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE media.metrics:": metrics item dumps.
std::unique_ptr<BugreportSectionParser> CreateDumpsysMediaMetricsParser(
    const BugreportParserDeps& deps);

// Small shared parser for services with miscellaneous timestamped state
// fields / debug logs (see dumpsys_misc_history_parser.cc).
std::unique_ptr<BugreportSectionParser> CreateDumpsysTimeDetectorParser(
    const BugreportParserDeps& deps);
std::unique_ptr<BugreportSectionParser> CreateDumpsysTimeZoneDetectorParser(
    const BugreportParserDeps& deps);
std::unique_ptr<BugreportSectionParser> CreateDumpsysThreadNetworkParser(
    const BugreportParserDeps& deps);
std::unique_ptr<BugreportSectionParser> CreateDumpsysUwbParser(
    const BugreportParserDeps& deps);
std::unique_ptr<BugreportSectionParser> CreateDumpsysUsbParser(
    const BugreportParserDeps& deps);
std::unique_ptr<BugreportSectionParser> CreateDumpsysPhoneExtrasParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE power:": wake lock log + suspend blockers -> slices.
std::unique_ptr<BugreportSectionParser> CreateDumpsysPowerParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE activity:": process starts / app errors / recent tasks.
std::unique_ptr<BugreportSectionParser> CreateDumpsysActivityProcessesParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE audio:": AudioService EventLogger blocks -> instants.
std::unique_ptr<BugreportSectionParser> CreateDumpsysAudioParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE activity:": running services + provider connections.
std::unique_ptr<BugreportSectionParser> CreateDumpsysActivityServicesParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE sensorservice:": recent events + registrations.
std::unique_ptr<BugreportSectionParser> CreateDumpsysSensorServiceParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE display:": brightness event ring buffers.
std::unique_ptr<BugreportSectionParser> CreateDumpsysDisplayParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE notification:": posted/enqueued notification records.
std::unique_ptr<BugreportSectionParser> CreateDumpsysNotificationParser(
    const BugreportParserDeps& deps);

// "DUMP OF SERVICE alarm:": TIME_TICK / wakeup / removal history.
std::unique_ptr<BugreportSectionParser> CreateDumpsysAlarmParser(
    const BugreportParserDeps& deps);

// "VM TRACES JUST NOW" / "VM TRACES AT LAST ANR" dumpstate sections:
// per-process stack dump headers -> instants.
std::unique_ptr<BugreportSectionParser> CreateVmTracesParser(
    const BugreportParserDeps& deps);

}  // namespace perfetto::trace_processor::android_bugreport

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ANDROID_BUGREPORT_BUGREPORT_PARSERS_H_
