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

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_TRACK_EVENT_PLUGIN_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_TRACK_EVENT_PLUGIN_H_

#include <memory>
#include <vector>

#include "perfetto/base/logging.h"

namespace perfetto::trace_processor {

namespace util {
class ProtoToArgsParser;
}

// A plugin that handles TrackEvent extension messages at the args level.
//
// RegisterOverrides() is called once, when the TrackEventParser is built. A
// plugin installs parsing overrides on the args parser for the extension
// message types it owns; each override fires while ParseMessage walks an event,
// receiving the parsed message. An override may run a side effect and return
// nullopt to let the field keep flowing into args, or return a Status to take
// it over (see ProtoToArgsParser::AddParsingOverrideForType).
//
// The extension descriptor must be in the pool for an override to fire. The
// frameworks/base descriptors are registered by RegisterAdditionalModules,
// which is not linked into the minimal build, so plugins add nothing there.
class TrackEventPlugin {
 public:
  virtual ~TrackEventPlugin();
  virtual void RegisterOverrides(util::ProtoToArgsParser& args_parser) = 0;
};

// Owns the registered plugins and installs their overrides on the args parser.
//
// TrackEventParser publishes its args parser via set_args_parser() when it is
// constructed. Plugins register later, when the additional proto modules are
// set up, and each plugin's overrides are installed straight away. The registry
// stays empty in the minimal build, where no plugin registers.
class TrackEventPluginRegistry {
 public:
  void set_args_parser(util::ProtoToArgsParser* args_parser) {
    args_parser_ = args_parser;
  }

  void Register(std::unique_ptr<TrackEventPlugin> plugin) {
    PERFETTO_DCHECK(args_parser_);
    plugin->RegisterOverrides(*args_parser_);
    plugins_.push_back(std::move(plugin));
  }

 private:
  util::ProtoToArgsParser* args_parser_ = nullptr;
  std::vector<std::unique_ptr<TrackEventPlugin>> plugins_;
};

}  // namespace perfetto::trace_processor

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_PROTO_TRACK_EVENT_PLUGIN_H_
