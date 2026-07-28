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
// The amalgamated SDK is a large vendored blob; -w silences its warnings
// portably (gcc and clang) so they don't drown out warnings in real code.
#cgo CXXFLAGS: -std=c++17 -DNDEBUG -w
#cgo LDFLAGS: -lstdc++ -lpthread -ldl
#include <stdlib.h>
#include "shim.h"
*/
import "C"

import "unsafe"

// Backend selects which tracing backend(s) the producer connects to. Values can
// be OR-combined.
type Backend uint32

const (
	// BackendInProcess keeps trace buffers in this process's memory. Traces are
	// captured via an in-process Session (see NewInProcessSession).
	BackendInProcess Backend = 1 << 0
	// BackendSystem connects to the system tracing service (traced), so traces
	// are captured by an external consumer such as the `perfetto` CLI.
	BackendSystem Backend = 1 << 1
)

// PerfettoTeType values, matching the C ABI.
const (
	typeSliceBegin int32 = 1
	typeSliceEnd   int32 = 2
	typeInstant    int32 = 3
)

// Init initializes the global Perfetto producer and the track event data
// source. It is safe to call more than once, but once a backend is initialized
// further calls for that backend are ignored. Call this once at startup, before
// registering categories.
func Init(backends Backend) {
	C.GoPerfettoInit(C.uint32_t(backends))
}

// DebugArg is a string key/value debug annotation attached to a track event.
type DebugArg struct {
	Name  string
	Value string
}

// Str is a convenience constructor for a string DebugArg.
func Str(name, value string) DebugArg { return DebugArg{Name: name, Value: value} }

// Category is a registered track event category. Create it with
// RegisterCategory, and after registering all categories call PublishCategories
// once so the tracing service learns about them.
type Category struct {
	handle unsafe.Pointer
}

// RegisterCategory registers a track event category with an optional
// human-readable description and zero or more tags. The returned Category owns
// native resources; call Close when it is no longer needed.
func RegisterCategory(name, description string, tags ...string) *Category {
	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	cDesc := C.CString(description)
	defer C.free(unsafe.Pointer(cDesc))

	var tagsPtr **C.char
	if len(tags) > 0 {
		arr, free := cStringArray(tags)
		defer free()
		tagsPtr = arr
	}
	h := C.GoPerfettoCategoryCreate(cName, cDesc, tagsPtr, C.size_t(len(tags)))
	return &Category{handle: h}
}

// PublishCategories tells the tracing service about all categories registered so
// far. Call it once after registering categories (and again if you register or
// destroy categories later).
func PublishCategories() { C.GoPerfettoPublishCategories() }

// Instant emits an instant (zero-duration) event.
func (c *Category) Instant(name string, args ...DebugArg) {
	c.emit(typeInstant, name, args)
}

// Begin opens a slice with the given name. Pair it with End (typically via
// defer, or use Slice which returns the closer).
func (c *Category) Begin(name string, args ...DebugArg) {
	c.emit(typeSliceBegin, name, args)
}

// End closes the most recently opened slice on this category's track.
func (c *Category) End(args ...DebugArg) {
	c.emit(typeSliceEnd, "", args)
}

// Slice opens a slice and returns a function that closes it, intended for use
// with defer:
//
//	defer cat.Slice("work")()
func (c *Category) Slice(name string, args ...DebugArg) func() {
	c.Begin(name, args...)
	return func() { c.End() }
}

// Close releases the native resources held by the category. After Close the
// category must not be used.
func (c *Category) Close() {
	if c.handle != nil {
		C.GoPerfettoCategoryDestroy(c.handle)
		c.handle = nil
	}
}

func (c *Category) emit(typ int32, name string, args []DebugArg) {
	if c == nil || c.handle == nil {
		return
	}
	var cName *C.char
	if name != "" {
		cName = C.CString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	var namesPtr, valsPtr **C.char
	if len(args) > 0 {
		names := make([]string, len(args))
		vals := make([]string, len(args))
		for i, a := range args {
			names[i] = a.Name
			vals[i] = a.Value
		}
		na, freeNames := cStringArray(names)
		defer freeNames()
		va, freeVals := cStringArray(vals)
		defer freeVals()
		namesPtr, valsPtr = na, va
	}

	C.GoPerfettoEmit(c.handle, C.int32_t(typ), cName, namesPtr, valsPtr,
		C.size_t(len(args)))
}

// cStringArray allocates a C array of `char*` holding a C copy of each string.
// The returned free function releases every string and the array itself.
func cStringArray(strs []string) (**C.char, func()) {
	ptrSize := unsafe.Sizeof((*C.char)(nil))
	arr := C.malloc(C.size_t(uintptr(len(strs)) * ptrSize))
	view := unsafe.Slice((**C.char)(arr), len(strs))
	for i, s := range strs {
		view[i] = C.CString(s)
	}
	free := func() {
		for i := range view {
			C.free(unsafe.Pointer(view[i]))
		}
		C.free(arr)
	}
	return (**C.char)(arr), free
}
