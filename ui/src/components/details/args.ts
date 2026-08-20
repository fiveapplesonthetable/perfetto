// Copyright (C) 2023 The Android Open Source Project
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
import {isString} from '../../base/object_utils';
import {Icons} from '../../base/semantic_icons';
import {exists} from '../../base/utils';
import {Anchor} from '../../widgets/anchor';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {TreeNode} from '../../widgets/tree';
import type {Args, ArgsDict, ArgValue} from '../sql_utils/args';
import type {Trace} from '../../public/trace';
import {asUtid} from '../sql_utils/core_types';
import {getThreadInfo, type ThreadInfo} from '../sql_utils/thread';
import {renderThreadRef} from '../widgets/thread';

// Renders slice arguments (key/value pairs) as a subtree.
export function renderArguments(
  trace: Trace,
  args: ArgsDict,
  extraMenuItems?: (key: string, arg: ArgValue) => m.Children,
): m.Children {
  if (hasArgs(args)) {
    return Object.entries(args).map(([key, value]) =>
      renderArgsTree(trace, key, key, value, extraMenuItems),
    );
  }
  return undefined;
}

export function hasArgs(args?: ArgsDict): args is ArgsDict {
  return exists(args) && Object.keys(args).length > 0;
}

function renderArgsTree(
  trace: Trace,
  key: string,
  fullKey: string,
  args: Args,
  extraMenuItems?: (path: string, arg: ArgValue) => m.Children,
): m.Children {
  if (args instanceof Array) {
    return m(
      TreeNode,
      {
        left: key,
        summary: renderArraySummary(args),
      },
      args.map((value, index) =>
        renderArgsTree(
          trace,
          `[${index}]`,
          `${fullKey}[${index}]`,
          value,
          extraMenuItems,
        ),
      ),
    );
  }
  if (args !== null && typeof args === 'object') {
    if (Object.keys(args).length === 1) {
      const [[childName, value]] = Object.entries(args);
      return renderArgsTree(
        trace,
        `${key}.${childName}`,
        `${fullKey}.${childName}`,
        value,
        extraMenuItems,
      );
    }
    return m(
      TreeNode,
      {
        left: key,
        summary: renderDictSummary(args),
      },
      Object.entries(args).map(([childName, child]) =>
        renderArgsTree(
          trace,
          childName,
          `${fullKey}.${childName}`,
          child,
          extraMenuItems,
        ),
      ),
    );
  }
  return m(TreeNode, {
    left: renderArgKey(key, fullKey, args, extraMenuItems),
    right: renderArgValue(trace, key, args),
  });
}

function renderArgKey(
  key: string,
  fullKey: string,
  value: ArgValue,
  extraMenuItems?: (path: string, arg: ArgValue) => m.Children,
): m.Children {
  if (value === undefined) {
    return key;
  } else {
    return m(
      PopupMenu,
      {trigger: m(Anchor, {icon: Icons.ContextMenu}, key)},
      m(MenuItem, {
        label: 'Copy full key',
        icon: 'content_copy',
        onclick: () => navigator.clipboard.writeText(fullKey),
      }),
      extraMenuItems?.(fullKey, value),
    );
  }
}

function renderArgValue(
  trace: Trace,
  key: string,
  value: ArgValue,
): m.Children {
  if (
    (key === 'utid' || key === 'end_utid') &&
    (typeof value === 'number' || typeof value === 'bigint')
  ) {
    return m(ThreadArgValue, {trace, utid: Number(value)});
  }
  if (isWebLink(value)) {
    return renderWebLink(value);
  }
  return `${value}`;
}

// Renders a utid-valued arg (e.g. rss_stat's responsible thread, or an async
// slice's utid/end_utid) as a thread reference, resolving the name async and
// showing the raw utid until it loads.
class ThreadArgValue
  implements m.ClassComponent<{trace: Trace; utid: number}>
{
  private info?: ThreadInfo;

  oninit({attrs}: m.Vnode<{trace: Trace; utid: number}>) {
    getThreadInfo(attrs.trace.engine, asUtid(attrs.utid)).then((info) => {
      this.info = info;
      m.redraw();
    });
  }

  view({attrs}: m.Vnode<{trace: Trace; utid: number}>): m.Children {
    return this.info !== undefined
      ? renderThreadRef(attrs.trace, this.info)
      : `${attrs.utid}`;
  }
}

function renderArraySummary(children: Args[]): m.Children {
  return `[ ... (${children.length} items) ]`;
}

function renderDictSummary(children: ArgsDict): m.Children {
  const summary = Object.keys(children).slice(0, 2).join(', ');
  const remaining = Object.keys(children).length - 2;
  if (remaining > 0) {
    return `{${summary}, ... (${remaining} more items)}`;
  } else {
    return `{${summary}}`;
  }
}

function isWebLink(value: unknown): value is string {
  return (
    isString(value) &&
    (value.startsWith('http://') || value.startsWith('https://'))
  );
}

function renderWebLink(url: string): m.Children {
  return m(Anchor, {href: url, target: '_blank', icon: 'open_in_new'}, url);
}
