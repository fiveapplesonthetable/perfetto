--
-- Copyright 2026 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed ON an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

INCLUDE PERFETTO MODULE android.memory.heap_graph.excluded_refs;

INCLUDE PERFETTO MODULE graphs.search;

-- The full tree of heap-graph objects reachable from a single object by
-- following references in one direction, shaped for a flamegraph.
--
-- Unlike the global class tree (which is a shortest-path tree rooted at the GC
-- roots) this is a forest rooted at one specific object: it answers "what does
-- this object reach" / "what reaches this object", not "how is it retained from
-- a root".
--
-- The heap reference graph is cyclic. This runs a BFS from `root_id`, so every
-- reachable object appears EXACTLY ONCE, attached to its shortest path back to
-- the root (ties broken by lowest id). The edges that would revisit an
-- already-seen object -- i.e. the cycles -- are simply not taken, so the result
-- is always a finite tree, and where a cycle exists the surviving edge is the
-- shortest one. This is the same primitive the class tree uses
-- (graph_reachable_bfs), just rooted at one object instead of every GC root.
--
-- Direction is chosen by which reference column feeds the edge source vs dest:
--   * outgoing ("what `root_id` references, transitively"):
--       src = owner_id, dest = owned_id
--   * incoming ("what references `root_id`, transitively"):
--       src = owned_id, dest = owner_id
--
-- `id` is the heap_graph_object id. Because each object appears once, it doubles
-- as the flamegraph tree-node id, so a caller can use it both to render the
-- flamegraph and to navigate to the underlying object. The root row has a NULL
-- `parent_id`.
CREATE PERFETTO MACRO _heap_graph_object_reference_tree(
  -- Id of the heap_graph_object to root the tree at.
  root_id Expr,
  -- Reference column that feeds the BFS edge source (owner_id for outgoing,
  -- owned_id for incoming).
  src ColumnName,
  -- Reference column that feeds the BFS edge destination (owned_id for
  -- outgoing, owner_id for incoming).
  dest ColumnName
)
-- Returns (id, parent_id, name, self_size, native_size, self_count), one row
-- per reachable object.
RETURNS TableOrSubquery
AS (
  SELECT
    bfs.node_id AS id,
    bfs.parent_node_id AS parent_id,
    cls.name AS name,
    obj.self_size AS self_size,
    obj.native_size AS native_size,
    1 AS self_count
  FROM graph_reachable_bfs!(
    (
      SELECT
        ref.$src AS source_node_id,
        ref.$dest AS dest_node_id
      FROM heap_graph_reference AS ref
      WHERE
        ref.$src IS NOT NULL
        AND ref.$dest IS NOT NULL
        -- Weak / phantom / finalizer referents don't retain, so they're
        -- dropped (matching the dominator and class trees).
        AND ref.id NOT IN _excluded_refs
      -- Deterministic tie-break when an object is reachable via several
      -- equal-length paths (mirrors _heap_graph_object_min_depth_tree).
      ORDER BY ref.$dest
    ),
    (
      SELECT $root_id AS node_id
    )
  ) AS bfs
  JOIN heap_graph_object AS obj ON obj.id = bfs.node_id
  JOIN heap_graph_class AS cls ON obj.type_id = cls.id
);
