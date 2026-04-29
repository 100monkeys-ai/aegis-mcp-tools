/**
 * ADR-117 Edge Mode — fleet operations MCP tool descriptors.
 *
 * These three tools form the operator-tier fan-out surface for AEGIS Edge:
 *
 *   - `aegis.edge.fleet.invoke` — dispatch a tool to one or many edge daemons
 *     under an explicit `FleetDispatchPolicy` (sequential / parallel / rolling
 *     × fail-fast / continue-on-error / stop-after).
 *   - `aegis.edge.fleet.list`   — resolve an `EdgeTarget` without dispatching;
 *     the dry-run preview path that operators use before destructive fan-outs.
 *   - `aegis.edge.fleet.cancel` — broadcast `Cancel` to every in-flight per-node
 *     command in a fleet operation.
 *
 * All three are gated by an operator / tenant-admin SecurityContext per
 * ADR-101. They carry the new descriptor flags introduced by ADR-117:
 *
 *   - `executor: "edge"`     — the dispatcher must consult the EdgeRouter
 *     rather than the local in-process tool registry.
 *   - `fleet_capable: true`  — the tool may target multiple edge nodes at once
 *     (i.e. accepts a Group / Selector / All `EdgeTarget`); tools without this
 *     flag may only target a single `Node`.
 *
 * Descriptors are intentionally co-located with the gateway. The orchestrator
 * tool registry merges these on top of its dynamic catalog so that operator
 * clients see a uniform surface regardless of where the tool implementation
 * physically lives.
 */

import type { AegisToolDefinition } from "../mcp/types.js";

/**
 * Shared `EdgeTarget` JSON Schema fragment. A discriminated union keyed on
 * `kind` matching the Rust `EdgeTarget` enum from ADR-117 §D:
 *
 *   - `{ kind: "node",     node_id }`
 *   - `{ kind: "group",    group_id | group_name }`
 *   - `{ kind: "selector", os?, arch?, tools?, labels?, tags? }`
 *   - `{ kind: "all" }`
 */
const edgeTargetSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "node_id"],
      additionalProperties: false,
      properties: {
        kind: { const: "node" },
        node_id: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { const: "group" },
        group_id: { type: "string", minLength: 1 },
        group_name: { type: "string", minLength: 1 },
      },
      anyOf: [{ required: ["group_id"] }, { required: ["group_name"] }],
    },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { const: "selector" },
        os: { type: "string" },
        arch: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        labels: {
          type: "object",
          additionalProperties: false,
          properties: {
            equals: {
              type: "array",
              items: {
                type: "object",
                required: ["key", "value"],
                additionalProperties: false,
                properties: {
                  key: { type: "string" },
                  value: { type: "string" },
                },
              },
            },
            exists: { type: "array", items: { type: "string" } },
            in: {
              type: "array",
              items: {
                type: "object",
                required: ["key", "values"],
                additionalProperties: false,
                properties: {
                  key: { type: "string" },
                  values: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        tags: {
          type: "object",
          additionalProperties: false,
          properties: {
            has: { type: "array", items: { type: "string" } },
            any_of: { type: "array", items: { type: "string" } },
            all_of: { type: "array", items: { type: "string" } },
            none_of: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { const: "all" },
      },
    },
  ],
} as const;

/**
 * `FleetDispatchPolicy` JSON Schema fragment. Mirrors the Rust struct from
 * ADR-117 §D. All fields optional; defaults are applied server-side per the
 * ADR (sequential mode, fail-fast, 60s per-target deadline).
 */
const fleetPolicySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      oneOf: [
        { const: "sequential" },
        { const: "parallel" },
        {
          type: "object",
          required: ["kind", "batch"],
          additionalProperties: false,
          properties: {
            kind: { const: "rolling" },
            batch: { type: "integer", minimum: 1 },
          },
        },
      ],
    },
    max_concurrency: { type: "integer", minimum: 1 },
    failure_policy: {
      oneOf: [
        { const: "fail-fast" },
        { const: "continue-on-error" },
        {
          type: "object",
          required: ["kind", "n"],
          additionalProperties: false,
          properties: {
            kind: { const: "stop-after" },
            n: { type: "integer", minimum: 1 },
          },
        },
      ],
    },
    require_min_targets: { type: "integer", minimum: 0 },
    per_target_deadline_secs: {
      type: "integer",
      minimum: 1,
      default: 60,
    },
  },
} as const;

/**
 * Extended descriptor type carrying the ADR-117 flags. The MCP wire schema
 * tolerates additional fields on tool descriptors (they are surfaced in the
 * `_meta` slot for clients that opt into the operator surface).
 */
export interface FleetToolDefinition extends AegisToolDefinition {
  executor: "edge";
  fleet_capable: boolean;
  security_context_tier: "system";
}

export const aegisEdgeFleetInvoke: FleetToolDefinition = {
  name: "aegis.edge.fleet.invoke",
  description:
    "Invoke a tool against one or many edge daemons with explicit dispatch policy (sequential / parallel / rolling × fail-fast / continue / stop-after). Streams per-node results.",
  executor: "edge",
  fleet_capable: true,
  security_context_tier: "system",
  inputSchema: {
    type: "object",
    required: ["tool", "args", "target"],
    additionalProperties: false,
    properties: {
      tool: {
        type: "string",
        minLength: 1,
        description:
          "Name of the tool to invoke against the resolved edge targets (e.g. `cmd.run`, `fs.write`).",
      },
      args: {
        type: "object",
        description: "Arguments forwarded verbatim to the target tool.",
      },
      target: {
        ...edgeTargetSchema,
        description:
          "EdgeTarget union — single node, group, label/tag selector, or all reachable edges in the tenant.",
      },
      policy: {
        ...fleetPolicySchema,
        description:
          "Dispatch policy. Defaults: { mode: 'sequential', failure_policy: 'fail-fast', per_target_deadline_secs: 60 } per ADR-117.",
      },
      security_context_name: {
        type: "string",
        description:
          "Security context to evaluate the inner tool call under. Defaults to the calling context if omitted.",
      },
    },
  },
};

export const aegisEdgeFleetList: FleetToolDefinition = {
  name: "aegis.edge.fleet.list",
  description:
    "Resolve an EdgeTarget without dispatching. Returns the list of edge daemons that the target would currently match. Operationally critical to preview before destructive fan-out.",
  executor: "edge",
  fleet_capable: true,
  security_context_tier: "system",
  inputSchema: {
    type: "object",
    required: ["target"],
    additionalProperties: false,
    properties: {
      target: {
        ...edgeTargetSchema,
        description:
          "EdgeTarget union to resolve. Same shape accepted by `aegis.edge.fleet.invoke`.",
      },
    },
  },
};

export const aegisEdgeFleetCancel: FleetToolDefinition = {
  name: "aegis.edge.fleet.cancel",
  description:
    "Broadcast Cancel to every in-flight per-node command in a fleet operation.",
  executor: "edge",
  fleet_capable: true,
  security_context_tier: "system",
  inputSchema: {
    type: "object",
    required: ["fleet_command_id"],
    additionalProperties: false,
    properties: {
      fleet_command_id: {
        type: "string",
        minLength: 1,
        description:
          "The fleet-level command id returned by `aegis.edge.fleet.invoke`. Cancels every per-node command still in flight.",
      },
    },
  },
};

/**
 * The full set of ADR-117 fleet operation tool descriptors, in the order
 * operators are most likely to discover them: invoke (the workhorse), list
 * (the dry-run preview), cancel (the abort path).
 */
export const edgeFleetToolDescriptors: readonly FleetToolDefinition[] = [
  aegisEdgeFleetInvoke,
  aegisEdgeFleetList,
  aegisEdgeFleetCancel,
];
