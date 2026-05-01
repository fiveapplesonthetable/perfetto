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

// Hand-rolled pprof Profile encoder, matching the bytes produced by the
// trace_processor PROFILE_FROM_TREE aggregate. Used by the flamegraph
// widget's Download pprof button so we don't have to round-trip the
// in-memory FlamegraphQueryData through SQL.
//
// Encodes only the subset of the Profile proto we need for tree-shaped
// data: sample_type, sample (location_id + value), location, function,
// string_table. Unsupported fields (mappings, lines beyond the leaf
// function, labels, comments) are intentionally omitted.

import {FlamegraphNode} from './flamegraph';

const enum ProfileField {
  kSampleType = 1,
  kSample = 2,
  kLocation = 4,
  kFunction = 5,
  kStringTable = 6,
}

const enum ValueTypeField {
  kType = 1,
  kUnit = 2,
}

const enum SampleField {
  kLocationId = 1,
  kValue = 2,
}

const enum LocationField {
  kId = 1,
  kLine = 4,
}

const enum LineField {
  kFunctionId = 1,
}

const enum FunctionField {
  kId = 1,
  kName = 2,
  kSystemName = 3,
}

class Writer {
  private chunks: Uint8Array[] = [];
  private len = 0;

  bytes(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  byteLength(): number {
    return this.len;
  }

  writeRaw(b: Uint8Array): void {
    this.chunks.push(b);
    this.len += b.length;
  }

  writeVarint(v: number | bigint): void {
    let n = typeof v === 'bigint' ? v : BigInt(v);
    if (n < 0n) {
      // pprof's varint fields are positive in our usage; promote to u64.
      n = n & 0xffffffffffffffffn;
    }
    const tmp: number[] = [];
    do {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n !== 0n) byte |= 0x80;
      tmp.push(byte);
    } while (n !== 0n);
    this.writeRaw(Uint8Array.from(tmp));
  }

  writeTag(field: number, wireType: number): void {
    this.writeVarint((field << 3) | wireType);
  }

  writeVarintField(field: number, v: number | bigint): void {
    this.writeTag(field, 0);
    this.writeVarint(v);
  }

  writeLengthDelimitedField(field: number, payload: Uint8Array): void {
    this.writeTag(field, 2);
    this.writeVarint(payload.length);
    this.writeRaw(payload);
  }
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildPackedVarint(values: ReadonlyArray<number | bigint>): Uint8Array {
  const w = new Writer();
  for (const v of values) {
    w.writeVarint(v);
  }
  return w.bytes();
}

export interface PprofTreeNode {
  readonly id: number;
  readonly parentId: number; // -1 (or any non-positive id not present) marks a root.
  readonly name: string;
  readonly selfValue: number;
}

// Build a serialized pprof Profile from a flat tree of nodes.
//
// `sampleType` and `unit` populate the single sample_type entry; e.g.
// ('space', 'bytes') for a heap profile, ('wall', 'nanoseconds') for a
// slice flamegraph. Nodes whose `selfValue` is not strictly positive
// are skipped as samples but their location is still present in the
// proto so descendants can refer to them as ancestors.
export function buildPprofProfile(
  nodes: ReadonlyArray<PprofTreeNode>,
  sampleType: string,
  unit: string,
): Uint8Array {
  // Stage strings: [0]="", then sample_type, unit, then frame names.
  const stringTable: string[] = [''];
  const stringIndex = new Map<string, number>();
  stringIndex.set('', 0);
  const internString = (s: string): number => {
    const cached = stringIndex.get(s);
    if (cached !== undefined) return cached;
    const idx = stringTable.length;
    stringTable.push(s);
    stringIndex.set(s, idx);
    return idx;
  };

  const sampleTypeIdx = internString(sampleType);
  const unitIdx = internString(unit);

  // Function: one per unique frame name. Function id starts at 1.
  const nameToFunctionId = new Map<string, number>();
  const stagedFunctions: Array<{id: number; nameIdx: number}> = [];
  const getFunctionId = (name: string): number => {
    const existing = nameToFunctionId.get(name);
    if (existing !== undefined) return existing;
    const id = nameToFunctionId.size + 1;
    nameToFunctionId.set(name, id);
    stagedFunctions.push({id, nameIdx: internString(name)});
    return id;
  };

  // Location id == nodes_index + 1.
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    idToIndex.set(nodes[i].id, i);
  }
  const locationFunctionId: number[] = [];
  for (const n of nodes) {
    locationFunctionId.push(getFunctionId(n.name));
  }

  // Walk parent chain for each sample, leaf-first.
  const samples: Array<{
    locationIds: number[];
    value: number;
  }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.selfValue <= 0) continue;
    const visited = new Set<number>();
    const locs: number[] = [];
    let cur: number | undefined = i;
    while (cur !== undefined) {
      if (visited.has(cur)) {
        throw new Error(
          `flamegraph pprof: cycle detected at node id ${nodes[cur].id}`,
        );
      }
      visited.add(cur);
      locs.push(cur + 1);
      const parent = nodes[cur].parentId;
      const next = idToIndex.get(parent);
      cur = next;
    }
    samples.push({locationIds: locs, value: n.selfValue});
  }

  const profile = new Writer();

  // sample_type
  {
    const m = new Writer();
    m.writeVarintField(ValueTypeField.kType, sampleTypeIdx);
    m.writeVarintField(ValueTypeField.kUnit, unitIdx);
    profile.writeLengthDelimitedField(ProfileField.kSampleType, m.bytes());
  }

  // sample
  for (const s of samples) {
    const m = new Writer();
    m.writeLengthDelimitedField(
      SampleField.kLocationId,
      buildPackedVarint(s.locationIds),
    );
    m.writeLengthDelimitedField(
      SampleField.kValue,
      buildPackedVarint([s.value]),
    );
    profile.writeLengthDelimitedField(ProfileField.kSample, m.bytes());
  }

  // location
  for (let i = 0; i < nodes.length; i++) {
    const m = new Writer();
    m.writeVarintField(LocationField.kId, i + 1);
    const line = new Writer();
    line.writeVarintField(LineField.kFunctionId, locationFunctionId[i]);
    m.writeLengthDelimitedField(LocationField.kLine, line.bytes());
    profile.writeLengthDelimitedField(ProfileField.kLocation, m.bytes());
  }

  // function
  for (const fn of stagedFunctions) {
    const m = new Writer();
    m.writeVarintField(FunctionField.kId, fn.id);
    m.writeVarintField(FunctionField.kName, fn.nameIdx);
    m.writeVarintField(FunctionField.kSystemName, fn.nameIdx);
    profile.writeLengthDelimitedField(ProfileField.kFunction, m.bytes());
  }

  // string_table
  for (const s of stringTable) {
    profile.writeLengthDelimitedField(ProfileField.kStringTable, utf8(s));
  }

  return profile.bytes();
}

// Convenience for the flamegraph widget: convert FlamegraphNode rows
// from the in-memory render data into pprof bytes.
export function buildPprofFromFlamegraphNodes(
  nodes: ReadonlyArray<FlamegraphNode>,
  sampleType: string,
  unit: string,
): Uint8Array {
  const projected: PprofTreeNode[] = nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    selfValue: n.selfValue,
  }));
  return buildPprofProfile(projected, sampleType, unit);
}
