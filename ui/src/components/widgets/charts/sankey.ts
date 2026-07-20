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

import m from 'mithril';
import {SankeySvg} from '../charts_svg/sankey_svg';

export interface SankeyNode {
  readonly name: string;
  readonly color?: string;
  readonly depth?: number;
}

export interface SankeyLink {
  readonly source: string;
  readonly target: string;
  readonly value: number;
}

export interface SankeyData {
  readonly nodes: readonly SankeyNode[];
  readonly links: readonly SankeyLink[];
}

export interface SankeyChartAttrs {
  readonly data: SankeyData | undefined;
  readonly height?: number;
  readonly fillParent?: boolean;
  readonly className?: string;
  readonly formatValue?: (value: number) => string;
  readonly onNodeClick?: (node: SankeyNode) => void;
}

export class Sankey implements m.ClassComponent<SankeyChartAttrs> {
  view({attrs}: m.Vnode<SankeyChartAttrs>) {
    return m(SankeySvg, attrs);
  }
}
