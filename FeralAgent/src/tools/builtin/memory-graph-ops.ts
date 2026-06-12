/**
 * memory_graph — explicit CRUD over the agent's knowledge graph.
 *
 * The knowledge graph (MemoryGraph) is normally fed automatically by
 * MemoryExtractor after each conversation turn. This tool gives the agent
 * direct, intentional control: it can add nodes/edges, record structured
 * facts (subject-predicate-object triples), remove stale memories, and
 * query what it already knows.
 *
 * Actions:
 *   add_node    → create or update a node (entity/concept/event/fact)
 *   remove_node → delete a node and all its edges
 *   add_edge    → connect two nodes with a named relation
 *   remove_edge → disconnect nodes (optionally by relation)
 *   add_fact    → high-level: add_node(subject) + add_node(object) + add_edge
 *   query       → search nodes by label substring and/or type
 *   snapshot    → return full graph summary
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { MemoryGraph, GraphNode } from "../../memory/graph.ts";

const NODE_TYPES = new Set<string>(["entity", "concept", "event", "fact"]);

function labelToId(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 64) || "node";
}

export function createMemoryGraphOpsTool(graph: MemoryGraph): Tool {
  const manifest: ToolManifest = {
    name: "memory_graph",
    description:
      "Manage the agent's persistent knowledge graph. Add/remove nodes " +
      "(entities, concepts, events, facts) and edges (named relations), " +
      "record semantic facts as subject-predicate-object triples, or query " +
      "what is already known. Changes are persisted immediately and visible " +
      "in the Memory Graph UI.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description:
          "Required. One of: 'add_node', 'remove_node', 'add_edge', " +
          "'remove_edge', 'add_fact', 'query', 'snapshot'.",
        required: true,
      },
      label: {
        type: "string",
        description: "Human-readable node label. Required for add_node; used as fallback id source.",
        required: false,
      },
      id: {
        type: "string",
        description: "Node ID (slug). Auto-derived from label if omitted.",
        required: false,
      },
      type: {
        type: "string",
        description: "Node type: 'entity' | 'concept' | 'event' | 'fact'. Default: 'concept'.",
        required: false,
      },
      properties: {
        type: "object",
        description: "Optional key→value metadata to attach to a node.",
        required: false,
      },
      from: {
        type: "string",
        description: "Source node ID for add_edge / remove_edge.",
        required: false,
      },
      to: {
        type: "string",
        description: "Target node ID for add_edge / remove_edge.",
        required: false,
      },
      relation: {
        type: "string",
        description: "Edge label (e.g. 'knows', 'has', 'works_on', 'is'). Required for add_edge; optional filter for remove_edge.",
        required: false,
      },
      subject: {
        type: "string",
        description: "Subject label for add_fact (becomes an entity node).",
        required: false,
      },
      predicate: {
        type: "string",
        description: "Predicate for add_fact (e.g. 'likes', 'uses', 'prefers').",
        required: false,
      },
      object: {
        type: "string",
        description: "Object label for add_fact (becomes a concept node).",
        required: false,
      },
      label_contains: {
        type: "string",
        description: "Substring filter on node labels for 'query'.",
        required: false,
      },
    },

    async execute(args) {
      const action = typeof args.action === "string" ? args.action.trim() : "";

      switch (action) {
        case "add_node": {
          const label = typeof args.label === "string" && args.label.trim()
            ? args.label.trim() : "";
          if (!label) return { ok: false, content: "memory_graph add_node: 'label' is required.", error: "bad_args" };
          const nodeType = (typeof args.type === "string" && NODE_TYPES.has(args.type)
            ? args.type : "concept") as GraphNode["type"];
          const id = typeof args.id === "string" && args.id.trim()
            ? args.id.trim() : labelToId(label);
          const props = (typeof args.properties === "object" && args.properties !== null
            ? args.properties : {}) as Record<string, string>;
          graph.upsertNode(id, label, nodeType, props);
          graph.persist();
          return {
            ok: true,
            content: `Node added: "${label}" (id: ${id}, type: ${nodeType})`,
            data: { id, label, type: nodeType },
          };
        }

        case "remove_node": {
          const id = typeof args.id === "string" && args.id.trim()
            ? args.id.trim()
            : typeof args.label === "string" && args.label.trim()
              ? labelToId(args.label.trim())
              : "";
          if (!id) return { ok: false, content: "memory_graph remove_node: 'id' or 'label' is required.", error: "bad_args" };
          const removed = graph.removeNode(id);
          if (removed) graph.persist();
          return {
            ok: true,
            content: removed
              ? `Removed node "${id}" and its edges.`
              : `No node with id "${id}" found.`,
            data: { id, removed },
          };
        }

        case "add_edge": {
          const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : "";
          const to   = typeof args.to   === "string" && args.to.trim()   ? args.to.trim()   : "";
          const rel  = typeof args.relation === "string" && args.relation.trim() ? args.relation.trim() : "";
          if (!from || !to || !rel) {
            return { ok: false, content: "memory_graph add_edge: 'from', 'to', and 'relation' are required.", error: "bad_args" };
          }
          graph.addEdge(from, to, rel);
          graph.persist();
          return {
            ok: true,
            content: `Edge added: ${from} -[${rel}]-> ${to}`,
            data: { from, to, relation: rel },
          };
        }

        case "remove_edge": {
          const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : "";
          const to   = typeof args.to   === "string" && args.to.trim()   ? args.to.trim()   : "";
          if (!from || !to) {
            return { ok: false, content: "memory_graph remove_edge: 'from' and 'to' are required.", error: "bad_args" };
          }
          const rel = typeof args.relation === "string" && args.relation.trim()
            ? args.relation.trim() : undefined;
          const count = graph.removeEdge(from, to, rel);
          if (count > 0) graph.persist();
          return {
            ok: true,
            content: `Removed ${count} edge(s) between "${from}" and "${to}".`,
            data: { from, to, relation: rel, removed: count },
          };
        }

        case "add_fact": {
          const subject   = typeof args.subject   === "string" && args.subject.trim()   ? args.subject.trim()   : "";
          const predicate = typeof args.predicate === "string" && args.predicate.trim() ? args.predicate.trim() : "";
          const object    = typeof args.object    === "string" && args.object.trim()    ? args.object.trim()    : "";
          if (!subject || !predicate || !object) {
            return { ok: false, content: "memory_graph add_fact: 'subject', 'predicate', and 'object' are required.", error: "bad_args" };
          }
          graph.addFact(subject, predicate, object);
          graph.persist();
          return {
            ok: true,
            content: `Fact stored: "${subject}" -[${predicate}]-> "${object}"`,
            data: {
              subject, predicate, object,
              subject_id: labelToId(subject),
              object_id:  labelToId(object),
            },
          };
        }

        case "query": {
          const labelContains = typeof args.label_contains === "string" && args.label_contains.trim()
            ? args.label_contains.trim() : undefined;
          const nodeType = typeof args.type === "string" && NODE_TYPES.has(args.type)
            ? args.type as GraphNode["type"] : undefined;
          const nodes = graph.queryNodes(labelContains, nodeType);
          if (nodes.length === 0) {
            return { ok: true, content: "No nodes found matching the query.", data: { nodes: [], count: 0 } };
          }
          const lines = nodes.map((n) => `- ${n.label} (id: ${n.id}, type: ${n.type})`).join("\n");
          return {
            ok: true,
            content: `${nodes.length} node(s):\n${lines}`,
            data: { nodes, count: nodes.length },
          };
        }

        case "snapshot": {
          const data = graph.snapshot();
          const nodeArr = Object.values(data.nodes);
          const lines = nodeArr.map((n) => `- ${n.label} (${n.type})`).join("\n");
          return {
            ok: true,
            content: `Graph: ${nodeArr.length} nodes, ${data.edges.length} edges.\n\nNodes:\n${lines || "(empty)"}`,
            data: { nodes: nodeArr, edges: data.edges, nodeCount: nodeArr.length, edgeCount: data.edges.length },
          };
        }

        default:
          return {
            ok: false,
            content: `memory_graph: unknown action "${action}". Valid: add_node, remove_node, add_edge, remove_edge, add_fact, query, snapshot.`,
            error: "bad_args",
          };
      }
    },
  };
}
