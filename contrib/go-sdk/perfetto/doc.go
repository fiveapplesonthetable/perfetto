// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package perfetto provides Go bindings for the Perfetto tracing SDK.
//
// It wraps the Perfetto C SDK via cgo, mirroring the structure of the Rust
// bindings in contrib/rust-sdk. The binding compiles the amalgamated C SDK
// (generated with tools/gen_amalgamated) together with a thin C shim, so no
// external Perfetto shared library is required.
//
// # Generating the amalgamated SDK
//
// Before building, generate the amalgamated C SDK source (this is intentionally
// not checked in, like the Rust bindings):
//
//	tools/gen_amalgamated --sdk c \
//	    --output contrib/go-sdk/perfetto/perfetto
//
// This writes perfetto_c.h and perfetto_c.cc into this package's directory.
//
// # Emitting track events
//
//	perfetto.Init(perfetto.BackendSystem)
//	cat := perfetto.RegisterCategory("rendering", "Rendering events")
//	perfetto.PublishCategories()
//	defer cat.Slice("DrawFrame")()
//	cat.Instant("vsync", perfetto.Str("phase", "begin"))
//
// # Capturing a trace in-process
//
//	perfetto.Init(perfetto.BackendInProcess)
//	cat := perfetto.RegisterCategory("app", "App events")
//	perfetto.PublishCategories()
//	s := perfetto.NewInProcessSession()
//	defer s.Destroy()
//	s.Setup(perfetto.TraceConfig{BufferSizeKB: 1024, EnabledCategories: []string{"app"}}.Encode())
//	s.StartBlocking()
//	cat.Instant("hello")
//	s.StopBlocking()
//	traceBytes := s.ReadTrace() // serialized perfetto.protos.Trace
package perfetto
