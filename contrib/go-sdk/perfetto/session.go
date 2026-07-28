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

/*
#include <stdlib.h>
#include "shim.h"
*/
import "C"

import "unsafe"

// Session drives an in-process tracing session: it configures a set of buffers
// and data sources, starts and stops recording, and reads back the captured
// trace. Use it with BackendInProcess.
type Session struct {
	handle unsafe.Pointer
}

// NewInProcessSession creates an in-process tracing session. Init(BackendInProcess)
// must have been called first.
func NewInProcessSession() *Session {
	return &Session{handle: C.GoPerfettoSessionCreateInProcess()}
}

// Setup configures the session with a serialized perfetto.protos.TraceConfig.
// Build one with TraceConfig.Encode.
func (s *Session) Setup(config []byte) {
	var p unsafe.Pointer
	if len(config) > 0 {
		p = unsafe.Pointer(&config[0])
	}
	// The C SDK parses and copies the config synchronously, so passing the Go
	// slice pointer is safe (the callee does not retain it).
	C.GoPerfettoSessionSetup(s.handle, p, C.size_t(len(config)))
}

// StartBlocking starts recording and blocks until the session has started.
func (s *Session) StartBlocking() { C.GoPerfettoSessionStartBlocking(s.handle) }

// StopBlocking stops recording and blocks until the session has stopped. Call
// this before ReadTrace to ensure all data has been committed.
func (s *Session) StopBlocking() { C.GoPerfettoSessionStopBlocking(s.handle) }

// ReadTrace returns the captured trace as a serialized perfetto.protos.Trace.
// Call it after StopBlocking. Returns nil if the trace is empty.
func (s *Session) ReadTrace() []byte {
	var buf unsafe.Pointer
	var size C.size_t
	C.GoPerfettoSessionReadTrace(s.handle, &buf, &size)
	if buf == nil || size == 0 {
		return nil
	}
	defer C.GoPerfettoFree(buf)
	return C.GoBytes(buf, C.int(size))
}

// Destroy releases the session's native resources. After Destroy the session
// must not be used.
func (s *Session) Destroy() {
	if s.handle != nil {
		C.GoPerfettoSessionDestroy(s.handle)
		s.handle = nil
	}
}
