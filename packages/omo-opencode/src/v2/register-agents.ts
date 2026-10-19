// packages/omo-opencode/src/v2/register-agents.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { applyAgentConfig } from "../plugin-handlers/agent-config-handler"
import {
  loadPluginComponents,
  type PluginComponents,
} from "../plugin-handlers/plugin-components-loader"
import { log } from "../shared"
import { toV2AgentInfo } from "./agent-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

type PermissionRule = { action: string; resource: string; effect: string }

/**
 * Merge an incoming permission ruleset onto the rules already present on the agent.
 *
 * The V2 editor seeds `Agent.Info.default(id)` permissions (wildcard allow,
 * `external_directory` ask, `.env` guards) when a missing id is created. Replacing that
 * ruleset with the V1-derived rules would silently drop those guards, so incoming rules
 * are appended and de-duplicated by the exact `(action, resource, effect)` triple. The
 * effect is part of the key on purpose: a `deny` must coexist with a seeded wildcard
 * `allow` (later rule wins in V2), and collapsing on `(action, resource)` would silently
 * discard the deny. Mirrors the built-in `opencode.config.agent` plugin, which pushes,
 * per the spike findings.
 */
export function mergeAgentPermissions(
  existing: readonly PermissionRule[] | undefined,
  incoming: readonly PermissionRule[] | undefined,
): PermissionRule[] | undefined {
  const base = existing ?? []
  const add = incoming ?? []
  if (add.length === 0) return existing === undefined ? undefined : [...base]
  if (base.length === 0) return [...add]
  const key = (p: PermissionRule) => `${p.action}\u0000${p.resource}\u0000${p.effect}`
  const seen = new Set(base.map(key))
  const merged = [...base]
  for (const p of add) {
    const k = key(p)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(p)
  }
  return merged
}

/**
 * Assemble omo's V1-shaped agent config and project it into the V2 agent registry.
 *
 * `applyAgentConfig` only needs `ctx.directory` (verified: no `ctx.client` usage in the
 * handler chain), so we hand it a minimal `{ directory }`. All async work is completed
 * before `ctx.agent.transform` runs because V2 transform callbacks must be synchronous.
 */
export async function registerOmoAgents(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  pluginComponents?: PluginComponents,
): Promise<void> {
  const components = pluginComponents ?? (await loadPluginComponents({ pluginConfig }))

  const config: Record<string, unknown> = {}
  const agentResult = await applyAgentConfig({
    config,
    pluginConfig,
    ctx: { directory: ctx.location.directory },
    pluginComponents: components,
  })

  const defaultAgent =
    typeof config.default_agent === "string" ? config.default_agent : undefined

  // Precompute the full V2 payload before entering the synchronous transform callback.
  const mappedAgents = new Map<string, Record<string, unknown>>()
  for (const [id, v1] of Object.entries(agentResult)) {
    if (typeof v1 !== "object" || v1 === null) continue
    mappedAgents.set(id, toV2AgentInfo(id, v1 as Record<string, unknown>, pluginConfig))
  }

  await ctx.agent.transform((editor) => {
    for (const [id, mapped] of mappedAgents) {
      editor.update(id, (agent) => {
        const { permissions: incoming, request: incomingRequest, ...rest } = mapped
        Object.assign(agent, rest)

        const mergedPermissions = mergeAgentPermissions(agent.permissions as never, incoming as never)
        if (mergedPermissions !== undefined) agent.permissions = mergedPermissions as never

        if (incomingRequest !== undefined) {
          const prev = (agent.request ?? {}) as {
            settings?: Record<string, unknown>
            headers?: Record<string, unknown>
            body?: Record<string, unknown>
          }
          const next = (incomingRequest ?? {}) as typeof prev
          agent.request = {
            settings: { ...(prev.settings ?? {}), ...(next.settings ?? {}) },
            headers: { ...(prev.headers ?? {}), ...(next.headers ?? {}) },
            body: { ...(prev.body ?? {}), ...(next.body ?? {}) },
          } as never
        }
      })
    }
    if (defaultAgent !== undefined) editor.default(defaultAgent)
  })

  log("[v2] agents registered", { agentCount: mappedAgents.size, defaultAgent })
}
