// packages/omo-opencode/src/v2/register-mcps.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createBuiltinMcps } from "../mcp"
import { log } from "../shared"
import { toV2McpConfigs } from "./mcp-mapping"
import { omoRuntimeKeyFor } from "./register-tools"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

/**
 * Register omo's built-in MCP servers into the V2 MCP domain.
 *
 * V2 exposes `ctx.mcp.transform(editor)` where the editor has `list/get/set/update/remove`, so a
 * plugin can contribute MCP servers. This restores the tier-1 built-ins
 * (`websearch`, `context7`, `grep_app`, `lsp`, `codegraph`) — including the `lsp` server that
 * serves all eight `lsp_*` tools — which the V1 plugin added through its `config` hook.
 *
 * Registration is synchronous, cheap and idempotent (V2 replays transforms and owns their
 * cleanup), memoized per `(directory, context identity, config)` like the other V2 registrars.
 */

export type RegisterMcpDeps = {
  readonly createBuiltinMcps?: typeof createBuiltinMcps
}

const registeredKeys = new Set<string>()

/** Test seam: clears the memoized MCP registrations (production never calls this). */
export function resetOmoMcpCache(): void {
  registeredKeys.clear()
}

export async function registerOmoMcps(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterMcpDeps = {},
): Promise<void> {
  const mcp = ctx.mcp
  if (typeof mcp?.transform !== "function") {
    log("[v2] mcp registration skipped", { reason: "ctx.mcp.transform unavailable" })
    return
  }

  const key = omoRuntimeKeyFor(ctx, pluginConfig)
  if (registeredKeys.has(key)) return

  const createBuiltin = deps.createBuiltinMcps ?? createBuiltinMcps
  const builtin = createBuiltin(pluginConfig.disabled_mcps ?? [], pluginConfig, {
    cwd: ctx.location.directory,
  })
  const mapped = toV2McpConfigs(builtin)
  const names = Object.keys(mapped)

  await mcp.transform((editor) => {
    for (const [name, config] of Object.entries(mapped)) {
      const existing = editor.get(name)
      if (existing === undefined) editor.set(name, config)
      else editor.update(name, (current) => Object.assign(current, config))
    }
  })

  registeredKeys.add(key)
  log("[v2] mcps registered", { registered: names.length, names })
}
