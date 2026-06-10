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

#include "src/trace_processor/importers/android_bugreport/bugreport_section_parser.h"

#include <memory>

#include "perfetto/ext/base/string_view.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_format.h"
#include "src/trace_processor/importers/android_bugreport/bugreport_parsers.h"

namespace perfetto::trace_processor::android_bugreport {

BugreportSectionParser::~BugreportSectionParser() = default;

base::Status BugreportSectionParser::EndOfSection() {
  return base::OkStatus();
}

namespace {

using Target = BugreportParserRegistration::Target;

// The single registration point for all bugreport section parsers.
//
// To support a format change introduced in Android release (SDK version) N:
// cap the existing entry at {min_sdk, N - 1}, implement the new format in a
// new parser (or a versioned branch inside the same parser, for small
// drifts), and register it as {N, 0}.
constexpr BugreportParserRegistration kRegistry[] = {
    {Target::kDumpsysService, "activity", 0, 0, &CreateDumpsysBroadcastsParser},
    {Target::kDumpsysService, "activity", 0, 0,
     &CreateDumpsysActivityProcessesParser},
    {Target::kDumpsysService, "activity", 0, 0,
     &CreateDumpsysActivityServicesParser},
    {Target::kDumpsysService, "alarm", 0, 0, &CreateDumpsysAlarmParser},
    {Target::kDumpsysService, "appops", 0, 0, &CreateDumpsysAppOpsParser},
    {Target::kDumpsysService, "audio", 0, 0, &CreateDumpsysAudioParser},
    {Target::kDumpsysService, "bluetooth_manager", 0, 0,
     &CreateDumpsysBluetoothManagerParser},
    {Target::kDumpsysService, "connmetrics", 0, 0,
     &CreateDumpsysConnMetricsParser},
    {Target::kDumpsysService, "dbinfo", 0, 0, &CreateDumpsysDbinfoParser},
    {Target::kDumpsysService, "media.metrics", 0, 0,
     &CreateDumpsysMediaMetricsParser},
    {Target::kDumpsysService, "app_hibernation", 0, 0,
     &CreateDumpsysAppHibernationParser},
    {Target::kDumpsysService, "notification", 0, 0,
     &CreateDumpsysNotificationParser},
    {Target::kDumpsysService, "package", 0, 0, &CreateDumpsysPackageParser},
    {Target::kDumpsysService, "settings", 0, 0, &CreateDumpsysSettingsParser},
    {Target::kDumpsysService, "thread_network", 0, 0,
     &CreateDumpsysThreadNetworkParser},
    {Target::kDumpsysService, "time_detector", 0, 0,
     &CreateDumpsysTimeDetectorParser},
    {Target::kDumpsysService, "time_zone_detector", 0, 0,
     &CreateDumpsysTimeZoneDetectorParser},
    {Target::kDumpsysService, "usb", 0, 0, &CreateDumpsysUsbParser},
    {Target::kDumpsysService, "uwb", 0, 0, &CreateDumpsysUwbParser},
    // Declines (returns null): the phone dump's logs are all LocalLog-shaped
    // and fully covered by the catch-all; kept registered as documentation.
    {Target::kDumpsysService, "phone", 0, 0, &CreateDumpsysPhoneExtrasParser},
    {Target::kDumpsysService, "dropbox", 0, 0, &CreateDumpsysDropboxParser},
    {Target::kDumpsysService, "jobscheduler", 0, 0,
     &CreateDumpsysJobSchedulerParser},
    {Target::kDumpsysService, "display", 0, 0, &CreateDumpsysDisplayParser},
    {Target::kDumpsysService, "input", 0, 0, &CreateDumpsysInputParser},
    {Target::kDumpsysService, "input_method", 0, 0,
     &CreateDumpsysInputMethodParser},
    {Target::kDumpsysService, "power", 0, 0, &CreateDumpsysPowerParser},
    {Target::kDumpsysService, "sensorservice", 0, 0,
     &CreateDumpsysSensorServiceParser},
    {Target::kDumpsysService, "usagestats", 0, 0,
     &CreateDumpsysUsageStatsParser},
    // Catch-all: every dumpsys service is scanned for the standard Android
    // event-log idioms (StateMachine "rec[N]: time=..." records and
    // android.util.LocalLog "<timestamp> - <msg>" lines). Services with
    // bespoke parsers above still run this one in addition; bespoke parsers
    // cover formats this one does not.
    {Target::kDumpsysService, "*", 0, 0, &CreateDumpsysEventLogParser},
    {Target::kSection, "APP SERVICES", 0, 0, &CreateAppServicesEventLogParser},
    {Target::kSection, "APP PROVIDERS", 0, 0, &CreateAppServicesEventLogParser},
    {Target::kSection, "SERVICE HIGH", 0, 0, &CreateAppServicesEventLogParser},
    {Target::kSection, "VM TRACES", 0, 0, &CreateVmTracesParser},
};

}  // namespace

std::vector<std::unique_ptr<BugreportSectionParser>>
BugreportParserRegistry::Create(BugreportParserRegistration::Target target,
                                base::StringView name,
                                const BugreportParserDeps& deps) {
  std::vector<std::unique_ptr<BugreportSectionParser>> parsers;
  const int32_t sdk = deps.format->sdk_version;
  for (const auto& reg : kRegistry) {
    if (reg.target != target) {
      continue;
    }
    bool name_matches = target == Target::kSection
                            ? name.StartsWith(reg.name)
                            : (name == base::StringView(reg.name) ||
                               (reg.name[0] == '*' && !name.empty()));
    if (!name_matches) {
      continue;
    }
    if (reg.min_sdk != 0 && sdk < reg.min_sdk) {
      continue;
    }
    if (reg.max_sdk != 0 && (sdk == 0 || sdk > reg.max_sdk)) {
      continue;
    }
    // Factories may decline (return null), e.g. the catch-all event log
    // parser declines for services whose logs a bespoke parser already
    // covers.
    auto parser = reg.factory(deps);
    if (parser) {
      parsers.push_back(std::move(parser));
    }
  }
  return parsers;
}

}  // namespace perfetto::trace_processor::android_bugreport
