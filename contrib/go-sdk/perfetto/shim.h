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

// Thin C shim over the Perfetto C SDK ABI, exposed to cgo. The Perfetto public
// API is largely static-inline functions and macros (producer.h, track_event.h,
// te_macros.h) that cgo cannot call directly; this shim wraps the pieces the Go
// package needs in plain, ABI-stable extern "C" functions. All handles are
// passed as void* so this header does not pull in any Perfetto types, keeping
// the cgo preamble self-contained.

#ifndef CONTRIB_GO_SDK_PERFETTO_SHIM_H_
#define CONTRIB_GO_SDK_PERFETTO_SHIM_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initializes the global producer with the given or-combination of backends
// (1 = in-process, 2 = system) and initializes the track event data source.
void GoPerfettoInit(uint32_t backends);

// Registers a track event category. `tags` is an array of `num_tags` C strings
// (may be NULL if num_tags is 0). The returned opaque handle owns copies of all
// the strings and must be released with GoPerfettoCategoryDestroy. Returns NULL
// on allocation failure. Call GoPerfettoPublishCategories after registering.
void* GoPerfettoCategoryCreate(const char* name,
                               const char* desc,
                               const char* const* tags,
                               size_t num_tags);
void GoPerfettoPublishCategories(void);
void GoPerfettoCategoryDestroy(void* cat);

// Emits one track event. `type` is a PerfettoTeType (1 = slice begin,
// 2 = slice end, 3 = instant). `name` may be NULL (e.g. for a slice end).
// `dbg_names`/`dbg_values` are parallel arrays of `n_args` C strings attached as
// string debug annotations.
void GoPerfettoEmit(void* cat,
                    int32_t type,
                    const char* name,
                    const char* const* dbg_names,
                    const char* const* dbg_values,
                    size_t n_args);

// In-process tracing session lifecycle.
void* GoPerfettoSessionCreateInProcess(void);
void GoPerfettoSessionSetup(void* session, const void* cfg, size_t cfg_size);
void GoPerfettoSessionStartBlocking(void* session);
void GoPerfettoSessionStopBlocking(void* session);
// Reads the whole trace into a single malloc()ed buffer; the caller takes
// ownership and must release it with GoPerfettoFree. On return *out_buf/*out_size
// describe the buffer (out_buf may be NULL if the trace is empty).
void GoPerfettoSessionReadTrace(void* session, void** out_buf, size_t* out_size);
void GoPerfettoSessionDestroy(void* session);

void GoPerfettoFree(void* p);

#ifdef __cplusplus
}
#endif

#endif  // CONTRIB_GO_SDK_PERFETTO_SHIM_H_
