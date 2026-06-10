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

// The default "structured" renderer for any dumpstate section / dumpsys
// service: a two-pane entity browser. The left "Structure" pane shows the
// hierarchy of entities (records, settings blocks, ...) parsed by
// entity_tree.ts, with a search box that filters entities (keeping their
// ancestors). The right pane shows the selected entity's properties in a
// DataGrid — or, for table/event-run entities, their structured tabular
// payload as a DataGrid — with any leftover prose lines in a collapsed
// "Text" block, so the raw data is never lost.

import m from 'mithril';
import {classNames} from '../../../base/classnames';
import {Icons} from '../../../base/semantic_icons';
import {DataGrid} from '../../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../../components/widgets/datagrid/datagrid_schema';
import {InMemoryDataSource} from '../../../components/widgets/datagrid/in_memory_data_source';
import type {Column} from '../../../components/widgets/datagrid/model';
import {Checkbox} from '../../../widgets/checkbox';
import {EmptyState} from '../../../widgets/empty_state';
import {Section} from '../../../widgets/section';
import {TextInput} from '../../../widgets/text_input';
import {Tree, TreeNode} from '../../../widgets/tree';
import type {EntityNode, EntityTable, EntityTree} from './entity_tree';
import {buildEntityTree} from './entity_tree';
import type {SectionRenderer} from './registry';

const PROPS_SCHEMA: SchemaRegistry = {
  root: {
    property: {title: 'Property', columnType: 'text'},
    value: {title: 'Value', columnType: 'text'},
  },
};
const PROPS_COLUMNS: readonly Column[] = [
  {id: 'property', field: 'property'},
  {id: 'value', field: 'value'},
];

// Hierarchy levels expanded by default (deeper nodes start collapsed and are
// only rendered once their parent is expanded).
const DEFAULT_EXPANDED_DEPTH = 2;
// Cap on the entity nodes rendered in any one child list.
const MAX_LIST_NODES = 500;

// Whether a property holds an uninteresting default, hidden when the
// "Hide empty values" checkbox is on (mirrors the SurfaceFlinger viewer's
// defaults filtering, with self-explanatory dumpsys-appropriate naming).
function isDefaultish(value: string): boolean {
  return (
    value === '' ||
    value === '0' ||
    value === 'false' ||
    value === 'null' ||
    value === '[]' ||
    value === '{}'
  );
}

function matchesQuery(node: EntityNode, q: string): boolean {
  return (
    node.name.toLowerCase().includes(q) || node.suffix.toLowerCase().includes(q)
  );
}

interface EntityViewAttrs {
  readonly lines: ReadonlyArray<string>;
}

class EntityView implements m.ClassComponent<EntityViewAttrs> {
  // Parsed entity tree, cached by the identity of the lines array (the page
  // keeps the array identity stable per selection).
  private lastLines?: ReadonlyArray<string>;
  private tree: EntityTree = buildEntityTree([]);

  // Component-local UI state; the page keys the content by section, so this
  // resets naturally when the user switches section.
  private selectedId?: number;
  private search = '';
  private hideEmpty = false;
  // Per-node collapsed overrides on top of the depth-based default.
  private collapsedOverride = new Map<number, boolean>();

  // Memoized properties DataGrid source, rebuilt only when the selected
  // entity or the defaults toggle changes, so the grid keeps its filter/sort
  // state across redraws.
  private gridCache?: {
    entity: EntityNode;
    hideEmpty: boolean;
    ds: InMemoryDataSource;
    count: number;
  };

  // Memoized DataGrid source for table/event-run payloads, keyed by entity.
  private tableCache?: {
    entity: EntityNode;
    ds: InMemoryDataSource;
    columns: readonly Column[];
    schema: SchemaRegistry;
  };

  view({attrs}: m.CVnode<EntityViewAttrs>): m.Children {
    if (attrs.lines !== this.lastLines) {
      this.lastLines = attrs.lines;
      this.tree = buildEntityTree(attrs.lines);
      this.selectedId = undefined;
      this.collapsedOverride.clear();
      this.gridCache = undefined;
      this.tableCache = undefined;
    }
    return m('.pf-bre-ev', [this.renderStructure(), this.renderProperties()]);
  }

  // ---- Left pane: entity hierarchy ----

  // Ids of entities to show for the current search: matches plus all their
  // ancestors. Undefined when not searching (show everything).
  private visibleIds(): Set<number> | undefined {
    const q = this.search.trim().toLowerCase();
    if (q === '') return undefined;
    const keep = new Set<number>();
    for (const node of this.tree.nodes) {
      if (!matchesQuery(node, q)) continue;
      let cur: EntityNode | undefined = node;
      while (cur !== undefined && !keep.has(cur.id)) {
        keep.add(cur.id);
        cur = cur.parentId >= 0 ? this.tree.nodes[cur.parentId] : undefined;
      }
    }
    return keep;
  }

  private renderStructure(): m.Children {
    const keep = this.visibleIds();
    const roots =
      keep === undefined
        ? this.tree.roots
        : this.tree.roots.filter((r) => keep.has(r.id));
    return m('.pf-bre-ev__pane.pf-bre-ev__pane--structure', [
      m(Section, {title: 'Structure'}, [
        m(TextInput, {
          className: 'pf-bre-ev__search',
          placeholder: 'Filter entities…',
          leftIcon: Icons.Search,
          value: this.search,
          onInput: (value: string) => {
            this.search = value;
          },
        }),
        roots.length === 0
          ? m(EmptyState, {icon: 'search_off', title: 'No matching entities'})
          : m(
              Tree,
              {className: 'pf-bre-ev__tree'},
              this.renderNodeList(roots, keep),
            ),
      ]),
    ]);
  }

  private renderNodeList(
    nodes: ReadonlyArray<EntityNode>,
    keep: Set<number> | undefined,
  ): m.Children {
    const shown = nodes
      .slice(0, MAX_LIST_NODES)
      .map((n) => this.renderNode(n, keep));
    if (nodes.length > MAX_LIST_NODES) {
      shown.push(
        m(TreeNode, {
          left: m(
            'span.pf-bre-truncation-note',
            `… ${(nodes.length - MAX_LIST_NODES).toLocaleString()} more ` +
              '(use the filter to narrow down)',
          ),
        }),
      );
    }
    return shown;
  }

  private renderNode(
    node: EntityNode,
    keep: Set<number> | undefined,
  ): m.Children {
    const children =
      keep === undefined
        ? node.children
        : node.children.filter((c) => keep.has(c.id));
    // While searching, all surviving nodes are expanded so matches are
    // visible; otherwise the first two levels start expanded.
    const collapsed =
      keep !== undefined
        ? false
        : this.collapsedOverride.get(node.id) ??
          node.depth >= DEFAULT_EXPANDED_DEPTH;
    const selected = node.id === this.selectedId;
    const label = m(
      'span.pf-bre-hnode',
      {
        class: classNames(selected && 'pf-bre-hnode--sel'),
        onclick: (e: Event) => {
          e.stopPropagation();
          this.selectedId = node.id;
        },
      },
      [
        m('span.pf-bre-hnode__name', node.name === '' ? '(empty)' : node.name),
        node.suffix !== '' && m('span.pf-bre-hnode__dim', node.suffix),
        node.children.length > 0 &&
          m(
            'span.pf-bre-hnode__count',
            {title: `${node.children.length} child entities`},
            `(${node.children.length})`,
          ),
      ],
    );
    return m(
      TreeNode,
      {
        left: label,
        collapsed,
        showCaret: children.length > 0,
        onCollapseChanged: (c: boolean) => {
          this.collapsedOverride.set(node.id, c);
        },
      },
      // Lazy: children are only rendered (and recursed into) when expanded.
      collapsed || children.length === 0
        ? undefined
        : this.renderNodeList(children, keep),
    );
  }

  // ---- Right pane: properties of the selected entity ----

  private selectedEntity(): EntityNode | undefined {
    return this.selectedId === undefined
      ? undefined
      : this.tree.nodes[this.selectedId];
  }

  // Builds the DataGrid model for a structured table/events payload: one
  // grid column per parsed table column.
  private buildTableGrid(
    entity: EntityNode,
    table: EntityTable,
  ): NonNullable<EntityView['tableCache']> {
    const colDefs = table.columns.map((title, i) => {
      const id = `c${i}`;
      return {id, title: title === '' ? `(col ${i + 1})` : title};
    });
    const schema: SchemaRegistry = {
      root: Object.fromEntries(
        colDefs.map((c) => [
          c.id,
          {title: c.title, columnType: 'text' as const},
        ]),
      ),
    };
    const columns: readonly Column[] = colDefs.map((c) => ({
      id: c.id,
      field: c.id,
    }));
    const rows = table.rows.map((r) =>
      Object.fromEntries(r.map((v, i) => [`c${i}`, v])),
    );
    return {entity, ds: new InMemoryDataSource(rows), columns, schema};
  }

  private renderTableGrid(entity: EntityNode, table: EntityTable): m.Children {
    const cache =
      this.tableCache?.entity === entity
        ? this.tableCache
        : (this.tableCache = this.buildTableGrid(entity, table));
    return m(
      '.pf-bre-ev__grid',
      m(DataGrid, {
        schema: cache.schema,
        rootSchema: 'root',
        data: cache.ds,
        columns: cache.columns,
        fillHeight: true,
      }),
    );
  }

  private buildGrid(entity: EntityNode): NonNullable<EntityView['gridCache']> {
    const rows = entity.props
      .filter((p) => !this.hideEmpty || !isDefaultish(p.value))
      .map((p) => ({property: p.key, value: p.value}));
    return {
      entity,
      hideEmpty: this.hideEmpty,
      ds: new InMemoryDataSource(rows),
      count: rows.length,
    };
  }

  private renderProperties(): m.Children {
    const entity = this.selectedEntity();
    if (entity === undefined) {
      return m(
        '.pf-bre-ev__pane.pf-bre-ev__pane--props',
        m(EmptyState, {
          icon: 'touch_app',
          title: 'Select a node',
          fillHeight: true,
        }),
      );
    }
    const table = entity.table;
    const cache =
      this.gridCache?.entity === entity &&
      this.gridCache.hideEmpty === this.hideEmpty
        ? this.gridCache
        : (this.gridCache = this.buildGrid(entity));
    return m('.pf-bre-ev__pane.pf-bre-ev__pane--props', [
      m(
        Section,
        {
          title: entity.name === '' ? '(empty)' : entity.name,
          subtitle: entity.suffix === '' ? undefined : entity.suffix,
        },
        [
          // Table/event-run entities render their structured payload as a
          // grid; regular entities render their key/value properties.
          table !== undefined
            ? this.renderTableGrid(entity, table)
            : m(
                '.pf-bre-ev__toolbar',
                m(Checkbox, {
                  label: 'Hide empty values',
                  checked: this.hideEmpty,
                  onchange: () => {
                    this.hideEmpty = !this.hideEmpty;
                  },
                }),
              ),
          table === undefined &&
            (cache.count === 0
              ? m('.pf-bre-ev__empty', 'No properties.')
              : m(
                  '.pf-bre-ev__grid',
                  m(DataGrid, {
                    schema: PROPS_SCHEMA,
                    rootSchema: 'root',
                    data: cache.ds,
                    columns: PROPS_COLUMNS,
                    fillHeight: true,
                  }),
                )),
          entity.text.length > 0 &&
            m(
              'details.pf-bre-ev__text',
              m(
                'summary',
                `Text (${entity.text.length.toLocaleString()} line` +
                  (entity.text.length === 1 ? ')' : 's)'),
              ),
              m(
                '.pf-bre-ev__text-lines',
                entity.text.map((l) => m('div', l)),
              ),
            ),
        ],
      ),
    ]);
  }
}

export const entityViewRenderer: SectionRenderer = {
  id: 'entity-view',
  matches: () => true,
  render: (lines) => m(EntityView, {lines}),
};
