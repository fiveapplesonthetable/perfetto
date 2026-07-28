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

package perfetto

import (
	"bytes"
	"testing"
)

func TestConfigEncode(t *testing.T) {
	// buffers { size_kb: 1024 }  data_sources { config { name: "track_event"
	//   track_event_config { enabled_categories: "cat" } } }
	got := TraceConfig{BufferSizeKB: 1024, EnabledCategories: []string{"cat"}}.Encode()
	want := []byte{
		0x0a, 0x03, 0x08, 0x80, 0x08, // buffers { size_kb: 1024 }
		0x12, 0x17, // data_sources (len 23)
		0x0a, 0x15, // config (len 21)
		0x0a, 0x0b, 't', 'r', 'a', 'c', 'k', '_', 'e', 'v', 'e', 'n', 't', // name
		0x8a, 0x07, 0x05, // track_event_config field 113 (len 5)
		0x12, 0x03, 'c', 'a', 't', // enabled_categories: "cat"
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("TraceConfig.Encode()\n got=% x\nwant=% x", got, want)
	}
}

// TestCaptureInProcess exercises the full path: init, register a category,
// configure + start an in-process session, emit events, stop, and read back the
// trace. It then checks the serialized trace contains the emitted event and
// debug-annotation strings, which round-trip through the C SDK's protobuf
// serialization.
func TestCaptureInProcess(t *testing.T) {
	Init(BackendInProcess)

	cat := RegisterCategory("gosdk_test", "Go SDK test category", "unit")
	defer cat.Close()
	PublishCategories()

	sess := NewInProcessSession()
	if sess == nil {
		t.Fatal("NewInProcessSession returned nil")
	}
	defer sess.Destroy()

	sess.Setup(TraceConfig{
		BufferSizeKB:      1024,
		EnabledCategories: []string{"gosdk_test"},
	}.Encode())
	sess.StartBlocking()

	cat.Instant("gosdk_instant_evt", Str("who", "gotest"), Str("lang", "go"))
	cat.Begin("gosdk_slice_evt")
	cat.End()
	func() { defer cat.Slice("gosdk_scoped_evt")() }()

	sess.StopBlocking()
	trace := sess.ReadTrace()

	if len(trace) == 0 {
		t.Fatal("ReadTrace returned no data; expected a non-empty trace")
	}

	// The event names are interned as raw strings in the trace, as are the
	// string debug annotations and the category name.
	for _, want := range []string{
		"gosdk_instant_evt",
		"gosdk_slice_evt",
		"gosdk_scoped_evt",
		"gosdk_test", // category name (in the track/data-source descriptor)
		"gotest",     // debug arg value
		"lang",       // debug arg name
	} {
		if !bytes.Contains(trace, []byte(want)) {
			t.Errorf("trace (%d bytes) does not contain %q", len(trace), want)
		}
	}
}
