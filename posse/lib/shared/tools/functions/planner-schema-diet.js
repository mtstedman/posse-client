import { PLANNER_TOOL_DESCRIPTIONS, PLANNER_CLAIMS_DESCRIPTION, PLANNER_SCOPE_DESCRIPTION } from "../../../catalog/planner-tool-guidance.js";
import { stripAgentSchemaDescriptions } from "./agent-schema.js";

// Planner-only presentation at MCP and embedded-provider boundaries. Keep
// validation constraints intact; consolidate evidence semantics once per claim.
export function applyPlannerSchemaDiet(definition, { dbExecutionAvailable = false } = {}) {
  if (definition?.function) {
    return { ...definition, function: applyPlannerSchemaDiet(definition.function, { dbExecutionAvailable }) };
  }
  const name = String(definition?.name || "");
  const canonical = name.startsWith("tools.") || name.startsWith("atlas.") ? name : `tools.${name}`;
  const description = PLANNER_TOOL_DESCRIPTIONS[canonical];
  const parameters = definition?.inputSchema || definition?.parameters;
  // Older handoff shapes retain their protocol-specific documentation.
  if (canonical === "tools.agent_handoff") {
    if (!parameters?.properties?.tasks) return definition;
    const schema = structuredClone(parameters);
    const fields = schema.properties.tasks.items.properties;
    if (fields.claims) {
      fields.claims = { ...stripAgentSchemaDescriptions(fields.claims), description: PLANNER_CLAIMS_DESCRIPTION };
    }
    if (fields.scope) fields.scope.description = PLANNER_SCOPE_DESCRIPTION;
    if (!dbExecutionAvailable) delete fields.executed_by_planner;
    return { ...definition, description, [definition.inputSchema ? "inputSchema" : "parameters"]: schema };
  }
  return description ? { ...definition, description } : definition;
}
