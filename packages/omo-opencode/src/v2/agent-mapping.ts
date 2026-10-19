// packages/omo-opencode/src/v2/agent-mapping.ts
import { Model } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getAgentConfigKey } from "../shared/agent-display-names"
import { lowerReasoningForModel, resolveAgentVariant } from "../shared/agent-variant"

const TOOL_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  edit: "edit",
  patch: "edit",
  apply_patch: "edit",
}

const PERMISSION_EFFECTS = new Set(["allow", "deny", "ask"])

function isPermissionEffect(value: unknown): value is string {
  return typeof value === "string" && PERMISSION_EFFECTS.has(value)
}

function normalizeMode(value: unknown): "subagent" | "primary" | "all" {
  return value === "primary" || value === "all" ? value : "subagent"
}

/**
 * Flatten one `permission` entry into V2 rules.
 *
 * The omo schema allows a resource-scoped map (e.g. `bash: { "rm -rf *": "ask" }`)
 * in addition to a bare effect string. A map becomes one rule per pattern with the
 * pattern as the resource; an unrecognised value is skipped rather than emitted as an
 * invalid V2 effect (which would fail response-schema validation for the whole list).
 */
function toPermissionRules(
  name: string,
  value: unknown,
): Array<{ action: string; resource: string; effect: string }> {
  const action = TOOL_ACTION[name] ?? name
  if (isPermissionEffect(value)) return [{ action, resource: "*", effect: value }]
  if (typeof value === "object" && value !== null) {
    const rules: Array<{ action: string; resource: string; effect: string }> = []
    for (const [pattern, effect] of Object.entries(value as Record<string, unknown>)) {
      if (isPermissionEffect(effect)) rules.push({ action, resource: pattern, effect })
    }
    return rules
  }
  return []
}

function toPermissions(permission: unknown, tools: unknown): Array<{ action: string; resource: string; effect: string }> | undefined {
  if (typeof permission === "object" && permission !== null) {
    const entries = Object.entries(permission)
    if (entries.length > 0) {
      const rules = entries.flatMap(([name, value]) => toPermissionRules(name, value))
      return rules.length > 0 ? rules : undefined
    }
  }
  if (typeof tools === "object" && tools !== null) {
    const entries = Object.entries(tools as Record<string, boolean>)
    if (entries.length > 0) {
      return entries.map(([name, enabled]) => ({ action: TOOL_ACTION[name] ?? name, resource: "*", effect: enabled ? "allow" : "deny" }))
    }
  }
  return undefined
}

/**
 * Lower a configured reasoning/variant value to a concrete V2 `model.variant`.
 *
 * V2 exposes the variant on the agent's model descriptor, but the omo config expresses
 * reasoning levels (`reasoning: "max"`). The V1 runtime lowers those per model in
 * `chat.params`; V2 registration has to do it up front. An explicit variant (either
 * `model#variant` or the deprecated `variant` field) is already authoritative and is
 * returned verbatim; otherwise the configured reasoning value is lowered against the
 * parsed model ref using the same helper the V1 path uses.
 */
function resolveModelVariant(
  parsed: { providerID: string; id: string; variant?: string },
  v1: Record<string, unknown>,
  id: string,
  config: OhMyOpenCodeConfig | undefined,
): string | undefined {
  if (parsed.variant !== undefined) return parsed.variant
  if (typeof v1.variant === "string") return v1.variant

  const configured = (config === undefined ? undefined : resolveAgentVariant(config, getAgentConfigKey(id)))
    ?? (typeof v1.reasoning === "string" ? v1.reasoning : undefined)
  if (configured === undefined) return undefined

  return lowerReasoningForModel(configured, { providerID: parsed.providerID, modelID: parsed.id }).variant
}

export function toV2AgentInfo(
  id: string,
  v1: Record<string, unknown>,
  config?: OhMyOpenCodeConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { name: id, mode: normalizeMode(v1.mode) }

  if (typeof v1.description === "string") out.description = v1.description
  if (typeof v1.prompt === "string") out.system = v1.prompt
  if (v1.hidden === true) out.hidden = true
  if (typeof v1.color === "string") out.color = v1.color
  if (typeof v1.steps === "number") out.steps = v1.steps

  if (typeof v1.model === "string") {
    const parsed = Model.Ref.parse(v1.model)
    const variant = resolveModelVariant(parsed, v1, id, config)
    out.model = variant === undefined
      ? { providerID: parsed.providerID, id: parsed.id }
      : { providerID: parsed.providerID, id: parsed.id, variant }
  } else if (typeof v1.model === "object" && v1.model !== null) {
    out.model = v1.model
  }

  const permissions = toPermissions(v1.permission, v1.tools)
  if (permissions !== undefined) out.permissions = permissions

  const body: Record<string, unknown> = {}
  if (typeof v1.temperature === "number") body.temperature = v1.temperature
  if (typeof v1.top_p === "number") body.top_p = v1.top_p
  if (Object.keys(body).length > 0) out.request = { body }

  return out
}
