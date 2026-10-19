/**
 * Per-session request configuration that only the V1 body carried.
 *
 * V1 accepted `system` (extra system content) and `tools` (the tool map to advertise) on both
 * `session.create` and `session.prompt`. The V2 forms accept neither: `SessionCreateInput` has
 * only `{id, parentID, title, agent, model, location, metadata, permissions}`, and the prompt body
 * is `{text, files, agents, skills, metadata, delivery, resume}`. Dropping those fields outright
 * would silently un-restrict delegated agents and strip the per-task skill / runtime prompt that
 * `delegate-task` and `background-agent` hand to their sessions.
 *
 * So the shim records them here and `registerOmoSessionPromptConfigHook` applies them on the V2
 * `context` hook, where `event.system` and `event.tools` are mutable and - measured on opencode
 * 2.0.30 (`.omo/evidence/20261016-v2-shim-parity-gaps/`, probe 12, which mutated both from a
 * probe plugin) - reach the provider request body.
 *
 * Both fields replace instead of accumulate: every call site re-sends the same complete map or the
 * same system content on each turn (`buildSyncPromptTools`, `setSessionTools`), so appending would
 * duplicate the content on every request.
 */

import { isRecord } from "../shared"

export type V1ToolEffect = boolean | "allow" | "deny" | "ask"

export type SessionPromptConfig = {
  /** Extra system content, in the order it was supplied. */
  system?: string[]
  /** V1 tool name -> effect. Only `false` / `"deny"` can be enforced on V2 (see below). */
  tools?: Record<string, V1ToolEffect>
}

/** One recorded config per live session. Bounded so a long-lived process cannot grow forever. */
const MAX_TRACKED_SESSIONS = 512
const configs = new Map<string, SessionPromptConfig>()

/**
 * V1 tool names whose V2 counterpart is named differently.
 *
 * `bash` became `shell`, `task` (the subagent spawner) became `subagent`, and the patch-style
 * aliases all collapse into `edit`. Everything else keeps its name and is matched against the tool
 * map the host actually advertises, so a wrong entry here can never delete an unrelated tool.
 */
export const V1_TO_V2_TOOL: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  patch: "edit",
  apply_patch: "edit",
}

export function normalizeSystemContent(system: unknown): string[] {
  if (typeof system === "string") return system.length > 0 ? [system] : []
  if (!Array.isArray(system)) return []
  return system.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
}

export function normalizeToolMap(tools: unknown): Record<string, V1ToolEffect> | undefined {
  if (!isRecord(tools)) return undefined
  const out: Record<string, V1ToolEffect> = {}
  for (const [name, value] of Object.entries(tools)) {
    if (typeof value === "boolean" || value === "allow" || value === "deny" || value === "ask") {
      out[name] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Record the `system` / `tools` of one V1 create or prompt body for a session. Absent fields keep
 * their previously recorded value; present fields replace it.
 */
export function recordSessionPromptConfig(
  sessionID: unknown,
  config: { system?: unknown; tools?: unknown },
): void {
  if (typeof sessionID !== "string" || sessionID.length === 0) return
  const system = normalizeSystemContent(config.system)
  const tools = normalizeToolMap(config.tools)
  if (system.length === 0 && tools === undefined) return

  const existing = configs.get(sessionID)
  const next: SessionPromptConfig = {}
  const nextSystem = system.length > 0 ? system : existing?.system
  const nextTools = tools !== undefined ? tools : existing?.tools
  if (nextSystem !== undefined) next.system = nextSystem
  if (nextTools !== undefined) next.tools = nextTools

  if (existing === undefined && configs.size >= MAX_TRACKED_SESSIONS) {
    const oldest = configs.keys().next().value
    if (typeof oldest === "string") configs.delete(oldest)
  }
  configs.delete(sessionID)
  configs.set(sessionID, next)
}

export function getSessionPromptConfig(sessionID: unknown): SessionPromptConfig | undefined {
  if (typeof sessionID !== "string") return undefined
  return configs.get(sessionID)
}

export function clearSessionPromptConfig(sessionID: unknown): void {
  if (typeof sessionID !== "string") return
  configs.delete(sessionID)
}

/** Test seam: the store is process-global, like the V1 session stores it mirrors. */
export function resetSessionPromptConfigs(): void {
  configs.clear()
}

/**
 * Resolve the advertised tool id a V1 name refers to, or undefined when it is not advertised.
 *
 * Three attempts, in order: the name itself (V2's own tools), the action alias (`bash` ->
 * `shell`), and the adapter's namespace prefix. The last one matters because omo registers its own
 * tools under a namespace (`omo_look_at`), while V1 prompt bodies deny them by bare name
 * (`look_at`) - without it those denials would be reported as unmapped and silently leave the tool
 * on.
 */
export function resolveAdvertisedTool(
  advertised: Record<string, unknown>,
  name: string,
  namespace?: string,
): string | undefined {
  if (advertised[name] !== undefined) return name
  const alias = V1_TO_V2_TOOL[name]
  if (alias !== undefined && advertised[alias] !== undefined) return alias
  if (namespace !== undefined && namespace !== "") {
    const namespaced = `${namespace}_${name}`
    if (advertised[namespaced] !== undefined) return namespaced
  }
  return undefined
}

export type SessionPromptConfigReport = (reason: "unmapped" | "ask", name: string) => void

/**
 * Apply a recorded config to a live `context` hook event.
 *
 * `system` content is appended to the request's system parts. `tools` is applied by *removing*
 * denied tools from the advertised map: V1's map only ever selected from tools the host already
 * offered, and V2's `event.tools` is `{description, input}`, so a tool the host does not advertise
 * cannot be added here either. `"ask"` has no per-request equivalent on V2 (the host's permission
 * rules are fixed at session creation), so the tool stays advertised and the caller reports it.
 *
 * `options.namespace` is the prefix the adapter registers its own tools under, so a V1 body that
 * denies `look_at` turns off V2's `omo_look_at`.
 */
export function applySessionPromptConfig(
  event: { system?: unknown; tools?: unknown },
  config: SessionPromptConfig,
  report: SessionPromptConfigReport,
  options: { namespace?: string } = {},
): void {
  for (const text of config.system ?? []) {
    if (Array.isArray(event.system)) event.system.push({ type: "text", text })
  }

  const tools = config.tools
  if (tools === undefined) return
  if (!isRecord(event.tools)) return
  const advertised = event.tools

  for (const [name, effect] of Object.entries(tools)) {
    if (effect === true || effect === "allow") continue
    if (effect === "ask") {
      report("ask", name)
      continue
    }
    const target = resolveAdvertisedTool(advertised, name, options.namespace)
    if (target === undefined) {
      report("unmapped", name)
      continue
    }
    delete advertised[target]
  }
}
