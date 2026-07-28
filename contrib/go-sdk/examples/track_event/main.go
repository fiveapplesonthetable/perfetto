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

// Command track_event captures an in-process trace of a few track events and
// writes it to example.pftrace, which can be opened at https://ui.perfetto.dev.
package main

import (
	"log"
	"os"
	"time"

	"github.com/google/perfetto/contrib/go-sdk/perfetto"
)

func main() {
	perfetto.Init(perfetto.BackendInProcess)

	cat := perfetto.RegisterCategory("example", "Example category", "demo")
	defer cat.Close()
	perfetto.PublishCategories()

	session := perfetto.NewInProcessSession()
	defer session.Destroy()
	session.Setup(perfetto.TraceConfig{
		BufferSizeKB:      1024,
		EnabledCategories: []string{"example"},
	}.Encode())
	session.StartBlocking()

	for i := 0; i < 5; i++ {
		cat.Instant("instant_hello",
			perfetto.Str("from", "perfetto"),
			perfetto.Str("sdk", "go"))

		func() {
			defer cat.Slice("scoped_hello", perfetto.Str("what", "sleep"))()
			time.Sleep(10 * time.Millisecond)
		}()
	}

	session.StopBlocking()
	trace := session.ReadTrace()

	if err := os.WriteFile("example.pftrace", trace, 0o644); err != nil {
		log.Fatalf("failed to write trace: %v", err)
	}
	log.Printf("wrote %d bytes to example.pftrace", len(trace))
}
