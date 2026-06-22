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

import {type NavState, stateToSubpage, subpageToState} from './nav_state';

describe('nav_state object-refs round-trip', () => {
  const cases: NavState[] = [
    {view: 'object-refs', params: {objId: 0x2a, dir: 'in'}},
    {view: 'object-refs', params: {objId: 0x2a, dir: 'out'}},
    {view: 'object-refs', params: {objId: 1, dir: 'out'}},
    {view: 'object-refs', params: {objId: 0xdeadbeef, dir: 'in'}},
  ];

  for (const state of cases) {
    it(`round-trips ${JSON.stringify(state.params)}`, () => {
      expect(subpageToState(stateToSubpage(state))).toEqual(state);
    });
  }

  it('encodes direction and a hex object id in the path', () => {
    expect(
      stateToSubpage({view: 'object-refs', params: {objId: 0x2a, dir: 'out'}}),
    ).toBe('object-refs_out_0x2a');
  });

  it('does not collide with the object view (object_ prefix)', () => {
    const obj = subpageToState('object_0x2a');
    expect(obj.view).toBe('object');
    const refs = subpageToState('object-refs_in_0x2a');
    expect(refs.view).toBe('object-refs');
  });
});
