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

// TraceConfig is a small builder for the subset of perfetto.protos.TraceConfig
// needed to record track events: one buffer and the track_event data source.
// It hand-encodes the protobuf so the package needs no generated proto code.
//
// For anything more elaborate, encode a full TraceConfig with a real protobuf
// library and pass the bytes straight to Session.Setup.
type TraceConfig struct {
	// BufferSizeKB is the size of the (single) central trace buffer, in KiB.
	BufferSizeKB uint32
	// EnabledCategories lists the track event categories to record. Use "*" to
	// enable all of them. If empty, no categories are explicitly enabled.
	EnabledCategories []string
}

// Field numbers, from the corresponding .proto files.
const (
	// TraceConfig
	fieldTraceConfigBuffers     = 1
	fieldTraceConfigDataSources = 2
	// TraceConfig.BufferConfig
	fieldBufferConfigSizeKB = 1
	// TraceConfig.DataSource
	fieldDataSourceConfig = 1
	// DataSourceConfig
	fieldDataSourceConfigName             = 1
	fieldDataSourceConfigTrackEventConfig = 113
	// TrackEventConfig
	fieldTrackEventConfigEnabledCategories = 2
)

// Encode serializes the TraceConfig to protobuf wire format, suitable for
// Session.Setup.
func (c TraceConfig) Encode() []byte {
	// buffers { size_kb = BufferSizeKB }
	var buffer []byte
	buffer = appendVarintField(buffer, fieldBufferConfigSizeKB, uint64(c.BufferSizeKB))

	// track_event_config { enabled_categories = ... }
	var teCfg []byte
	for _, cat := range c.EnabledCategories {
		teCfg = appendStringField(teCfg, fieldTrackEventConfigEnabledCategories, cat)
	}

	// data_sources { config { name = "track_event"; track_event_config { ... } } }
	var dsCfg []byte
	dsCfg = appendStringField(dsCfg, fieldDataSourceConfigName, "track_event")
	dsCfg = appendBytesField(dsCfg, fieldDataSourceConfigTrackEventConfig, teCfg)
	var dataSource []byte
	dataSource = appendBytesField(dataSource, fieldDataSourceConfig, dsCfg)

	var out []byte
	out = appendBytesField(out, fieldTraceConfigBuffers, buffer)
	out = appendBytesField(out, fieldTraceConfigDataSources, dataSource)
	return out
}

// --- minimal protobuf wire encoding ---

const (
	wireVarint = 0
	wireLen    = 2
)

func appendVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func appendTag(b []byte, field, wire int) []byte {
	return appendVarint(b, uint64(field)<<3|uint64(wire))
}

func appendVarintField(b []byte, field int, v uint64) []byte {
	b = appendTag(b, field, wireVarint)
	return appendVarint(b, v)
}

func appendBytesField(b []byte, field int, val []byte) []byte {
	b = appendTag(b, field, wireLen)
	b = appendVarint(b, uint64(len(val)))
	return append(b, val...)
}

func appendStringField(b []byte, field int, s string) []byte {
	return appendBytesField(b, field, []byte(s))
}
