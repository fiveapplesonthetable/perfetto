#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Wrap a raw `adb shell dumpsys activity --proto` capture into a Perfetto
trace so it opens directly in the Perfetto UI / trace_processor.

No device or framework change is required: the existing ActivityManager proto
dump is delivered into the trace via Perfetto's ExtensionDescriptor mechanism
(hooked onto TrackEvent), so trace_processor auto-decodes the whole
ActivityManagerServiceProto tree into the `args` table with no per-field
importer. The `com.android.ProcessState` UI plugin then pivots those args into
its process / service / binding graph.

The dumpsys output is already a serialized ActivityManagerServiceProto, and the
descriptor set is already a serialized FileDescriptorSet, so this only has to
frame them with a handful of protobuf field tags. It writes the wire bytes
directly and deliberately does NOT import the protobuf runtime — that keeps it
working on any Python / any protobuf version (the runtime's dynamic-extension
serialization is version-fragile).

Usage:
  # 1. Build a descriptor set covering perfetto_trace.proto + the AMS proto +
  #    the extension hook (one-off; needs an AOSP checkout for the AMS proto):
  protoc --include_imports \\
      --descriptor_set_out=combined.desc \\
      -I <perfetto>/  \\
      -I <aosp>/  \\
      -I <aosp>/external/protobuf/src \\
      -I tools/dumpsys_activity_to_trace \\
      dumpsys_activity_extension.proto

  # 2. Capture on the device (zero device change):
  adb shell dumpsys activity --proto > ams.pb

  # 3. Convert one snapshot:
  convert.py --desc combined.desc --in ams.pb --out ams.pftrace

  # ...or a directory of snapshots (sorted by name) into one scrubable trace.
  # Each dump becomes a snapshot, spaced --step ns apart (real per-snapshot
  # timestamps aren't in the dumpsys proto; v1 just spaces them evenly):
  convert.py --desc combined.desc --in-dir dumps/ --out series.pftrace
"""
import argparse
import os

# --- field numbers (from the perfetto protos) ---
TRACE_PACKET = 1  # Trace.packet
PKT_TIMESTAMP = 8  # TracePacket.timestamp
PKT_SEQ_ID = 10  # TracePacket.trusted_packet_sequence_id
PKT_TRACK_EVENT = 11  # TracePacket.track_event
PKT_TRACK_DESCRIPTOR = 60  # TracePacket.track_descriptor
PKT_EXTENSION_DESCRIPTOR = 72  # TracePacket.extension_descriptor
EXTDESC_EXTENSION_SET = 1  # ExtensionDescriptor.extension_set (FileDescriptorSet)
TD_UUID = 1  # TrackDescriptor.uuid
TD_NAME = 2  # TrackDescriptor.name
TE_TYPE = 9  # TrackEvent.type
TE_TRACK_UUID = 11  # TrackEvent.track_uuid
TE_NAME = 23  # TrackEvent.name
TYPE_INSTANT = 3  # TrackEvent.Type.TYPE_INSTANT
AM_DUMPSYS_EXT = 9950  # TrackEvent extension field carrying the AMS proto

TRACK_UUID = 77


def _varint(n):
  out = bytearray()
  while True:
    b = n & 0x7F
    n >>= 7
    out.append(b | 0x80 if n else b)
    if not n:
      return bytes(out)


def _vfield(field, value):  # varint field
  return _varint(field << 3) + _varint(value)


def _lfield(field,
            data):  # length-delimited field (bytes / string / submessage)
  return _varint((field << 3) | 2) + _varint(len(data)) + data


def _event_packet(ams, ts):
  """One instant TrackEvent carrying an AMS proto as the am_dumpsys extension."""
  te = (
      _vfield(TE_TYPE, TYPE_INSTANT) + _vfield(TE_TRACK_UUID, TRACK_UUID) +
      _lfield(TE_NAME, b'am_dumpsys') + _lfield(AM_DUMPSYS_EXT, ams))
  pkt = (
      _vfield(PKT_TIMESTAMP, ts) + _vfield(PKT_SEQ_ID, 1) +
      _lfield(PKT_TRACK_EVENT, te))
  return _lfield(TRACE_PACKET, pkt)


def main():
  ap = argparse.ArgumentParser(description=__doc__)
  ap.add_argument('--desc', required=True, help='combined FileDescriptorSet')
  ap.add_argument('--in', dest='inp', help='single dumpsys --proto file')
  ap.add_argument(
      '--in-dir',
      dest='indir',
      help='directory of dumpsys --proto files (sorted by name = a snapshot '
      'series, one scrubable trace)')
  ap.add_argument('--out', required=True, help='output .pftrace')
  ap.add_argument('--ts', type=int, default=1000, help='first snapshot ts (ns)')
  ap.add_argument(
      '--step',
      type=int,
      default=1_000_000_000,
      help='spacing between snapshots in ns (default 1s; real per-snapshot '
      'times are not in the dumpsys proto)')
  args = ap.parse_args()
  if (args.inp is None) == (args.indir is None):
    ap.error('pass exactly one of --in or --in-dir')

  if args.indir is not None:
    files = sorted(
        os.path.join(args.indir, f)
        for f in os.listdir(args.indir)
        if not f.startswith('.'))
  else:
    files = [args.inp]

  desc = open(args.desc, 'rb').read()
  # Packet 1: self-describing extension descriptor (the AMS schema), once.
  pkt_desc = _lfield(PKT_EXTENSION_DESCRIPTOR,
                     _lfield(EXTDESC_EXTENSION_SET, desc))
  # Packet 2: the track that hosts every snapshot event, once.
  td = _vfield(TD_UUID, TRACK_UUID) + _lfield(TD_NAME, b'AM dumpsys')
  pkt_track = (
      _vfield(PKT_TIMESTAMP, args.ts) + _vfield(PKT_SEQ_ID, 1) +
      _lfield(PKT_TRACK_DESCRIPTOR, td))

  trace = _lfield(TRACE_PACKET, pkt_desc) + _lfield(TRACE_PACKET, pkt_track)
  # One instant event per snapshot, evenly spaced.
  for i, path in enumerate(files):
    trace += _event_packet(open(path, 'rb').read(), args.ts + i * args.step)

  open(args.out, 'wb').write(trace)
  print('wrote %s (%d snapshot(s), %d bytes)' %
        (args.out, len(files), len(trace)))


if __name__ == '__main__':
  main()
