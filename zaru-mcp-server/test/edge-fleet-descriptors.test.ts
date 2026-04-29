import test from "node:test";
import assert from "node:assert/strict";

import {
  aegisEdgeFleetCancel,
  aegisEdgeFleetInvoke,
  aegisEdgeFleetList,
  edgeFleetToolDescriptors,
} from "../src/descriptors/edge-fleet.js";

test("edge-fleet descriptors: three operator-tier tools registered", () => {
  assert.equal(edgeFleetToolDescriptors.length, 3);
  const names = edgeFleetToolDescriptors.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "aegis.edge.fleet.cancel",
    "aegis.edge.fleet.invoke",
    "aegis.edge.fleet.list",
  ]);
});

test("edge-fleet descriptors: all carry executor=edge and fleet_capable=true", () => {
  for (const d of edgeFleetToolDescriptors) {
    assert.equal(d.executor, "edge", `${d.name} must have executor: "edge"`);
    assert.equal(
      d.fleet_capable,
      true,
      `${d.name} must declare fleet_capable: true`,
    );
    assert.equal(
      d.security_context_tier,
      "system",
      `${d.name} must be system-tier`,
    );
  }
});

test("aegis.edge.fleet.invoke: requires tool, args, target", () => {
  const schema = aegisEdgeFleetInvoke.inputSchema as Record<string, unknown>;
  assert.deepEqual(schema.required, ["tool", "args", "target"]);
  const props = schema.properties as Record<string, unknown>;
  assert.ok(props.tool, "tool prop");
  assert.ok(props.args, "args prop");
  assert.ok(props.target, "target prop");
  assert.ok(props.policy, "policy prop");
  assert.ok(props.security_context_name, "security_context_name prop");
});

test("aegis.edge.fleet.invoke: target is a discriminated union over node/group/selector/all", () => {
  const schema = aegisEdgeFleetInvoke.inputSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const target = props.target;
  const variants = target.oneOf as Array<Record<string, unknown>>;
  assert.equal(variants.length, 4);
  const kinds = variants
    .map((v) => {
      const p = v.properties as Record<string, Record<string, unknown>>;
      return p.kind.const as string;
    })
    .sort();
  assert.deepEqual(kinds, ["all", "group", "node", "selector"]);
});

test("aegis.edge.fleet.invoke: group target accepts either group_id or group_name", () => {
  const schema = aegisEdgeFleetInvoke.inputSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const variants = props.target.oneOf as Array<Record<string, unknown>>;
  const groupVariant = variants.find((v) => {
    const p = v.properties as Record<string, Record<string, unknown>>;
    return p.kind.const === "group";
  });
  assert.ok(groupVariant, "group variant exists");
  const anyOf = groupVariant.anyOf as Array<{ required: string[] }>;
  const required = anyOf.map((c) => c.required[0]).sort();
  assert.deepEqual(required, ["group_id", "group_name"]);
});

test("aegis.edge.fleet.invoke: policy mode covers sequential / parallel / rolling", () => {
  const schema = aegisEdgeFleetInvoke.inputSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const policyProps = props.policy.properties as Record<
    string,
    Record<string, unknown>
  >;
  const modeVariants = policyProps.mode.oneOf as Array<Record<string, unknown>>;
  // Two string-literal modes plus one rolling object variant.
  const literals = modeVariants
    .filter((v) => typeof v.const === "string")
    .map((v) => v.const)
    .sort();
  assert.deepEqual(literals, ["parallel", "sequential"]);
  const rolling = modeVariants.find((v) => v.type === "object");
  assert.ok(rolling, "rolling variant present");
  const rollingProps = rolling.properties as Record<string, unknown>;
  assert.ok(rollingProps.batch, "rolling carries batch size");
});

test("aegis.edge.fleet.invoke: failure_policy covers fail-fast / continue-on-error / stop-after", () => {
  const schema = aegisEdgeFleetInvoke.inputSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const policyProps = props.policy.properties as Record<
    string,
    Record<string, unknown>
  >;
  const variants = policyProps.failure_policy.oneOf as Array<
    Record<string, unknown>
  >;
  const literals = variants
    .filter((v) => typeof v.const === "string")
    .map((v) => v.const)
    .sort();
  assert.deepEqual(literals, ["continue-on-error", "fail-fast"]);
  const stopAfter = variants.find((v) => v.type === "object");
  assert.ok(stopAfter, "stop-after variant present");
});

test("aegis.edge.fleet.list: requires target and only target", () => {
  const schema = aegisEdgeFleetList.inputSchema as Record<string, unknown>;
  assert.deepEqual(schema.required, ["target"]);
  assert.equal(schema.additionalProperties, false);
});

test("aegis.edge.fleet.cancel: requires fleet_command_id", () => {
  const schema = aegisEdgeFleetCancel.inputSchema as Record<string, unknown>;
  assert.deepEqual(schema.required, ["fleet_command_id"]);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.fleet_command_id.type, "string");
});
