// Copyright (C) 2024 The Android Open Source Project
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

import m from 'mithril';
import {Icons} from '../../base/semantic_icons';
import type {Trace} from '../../public/trace';
import {Button} from '../../widgets/button';

// A details-panel button that switches to the default workspace and scrolls to
// the current selection there. Shown only when the selection is in a non-default
// workspace and the selected track also exists in the default workspace (so the
// jump has somewhere to land). Intended to be placed in a DetailsShell's
// `buttons` slot; returns undefined (rendered as nothing) when not applicable.
export function renderOpenInDefaultWorkspaceButton(trace: Trace): m.Children {
  const {currentWorkspace, defaultWorkspace, workspaces, selection} = trace;
  if (currentWorkspace === defaultWorkspace) return;
  const sel = selection.selection;
  if (sel.kind !== 'track_event') return;
  if (defaultWorkspace.getTrackByUri(sel.trackUri) === undefined) return;
  return m(Button, {
    label: 'Open in default workspace',
    icon: Icons.GoTo,
    onclick: () => {
      workspaces.switchWorkspace(defaultWorkspace);
      selection.scrollToSelection('focus');
    },
  });
}
