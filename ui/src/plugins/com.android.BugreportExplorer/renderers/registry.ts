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

// The extensibility point of the Bugreport Explorer: per-section/service
// renderers for the "structured" view mode.
//
// To add a specialized renderer for a dumpstate section or dumpsys service:
//  1. Create a new file in this directory exporting a `SectionRenderer`.
//  2. Add it to the `RENDERERS` list below (first match wins).
// Android dump formats drift across releases; `matches` receives the device's
// SDK version so a renderer can opt out (or a newer variant can take over)
// when the format changed.

import type m from 'mithril';
import type {Trace} from '../../../public/trace';
import {entityViewRenderer} from './entity_view';
import {systemPropertiesRenderer} from './system_properties';
import {dropboxRenderer} from './dropbox';
import {meminfoRenderer} from './meminfo';
import {cpuinfoRenderer} from './cpuinfo';
import {dfRenderer} from './df';
import {psiRenderer} from './psi';
import {procrankLibrankRenderer} from './procrank_librank';
import {uptimeHeaderRenderer} from './uptime_header';

// What is being rendered. `section` is the full dumpstate section name, e.g.
// "DUMPSYS (/system/bin/dumpsys)" or "SYSTEM PROPERTIES (getprop)" ('' for the
// dumpstate preamble). `service` is the dumpsys service name, set only within
// DUMPSYS sections.
export interface RendererSelection {
  readonly section: string;
  readonly service?: string;
}

export interface RenderContext {
  readonly trace: Trace;
  readonly selection: RendererSelection;
  readonly sdkVersion: number;
}

export interface SectionRenderer {
  readonly id: string;
  matches(sel: RendererSelection, sdkVersion: number): boolean;
  render(lines: ReadonlyArray<string>, ctx: RenderContext): m.Children;
}

// Specialized renderers, tried in order. The generic entity-view renderer is
// the fallback and is deliberately not in this list.
const RENDERERS: ReadonlyArray<SectionRenderer> = [
  systemPropertiesRenderer,
  dropboxRenderer,
  meminfoRenderer,
  cpuinfoRenderer,
  dfRenderer,
  psiRenderer,
  procrankLibrankRenderer,
  uptimeHeaderRenderer,
];

// Returns the first specialized renderer matching the selection, falling back
// to the generic entity-view renderer.
export function findRenderer(
  sel: RendererSelection,
  sdkVersion: number,
): SectionRenderer {
  return (
    RENDERERS.find((r) => r.matches(sel, sdkVersion)) ?? entityViewRenderer
  );
}
