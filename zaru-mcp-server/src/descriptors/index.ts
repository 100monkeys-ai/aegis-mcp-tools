/**
 * Local tool descriptor registry.
 *
 * The Zaru MCP server discovers most tools dynamically from the AEGIS
 * orchestrator. A small number of system-tier descriptors are co-located
 * here when ADRs designate `aegis-mcp-tools` as their canonical location
 * (per ADR-117 §"MCP tool surface").
 */

export {
  aegisEdgeFleetCancel,
  aegisEdgeFleetInvoke,
  aegisEdgeFleetList,
  edgeFleetToolDescriptors,
  type FleetToolDefinition,
} from "./edge-fleet.js";
