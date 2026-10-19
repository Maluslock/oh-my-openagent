import { Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { log } from "../shared"
import { registerOmoAgents } from "./register-agents"
import { registerOmoCommands } from "./register-commands"
import { registerOmoHooks } from "./register-hook-assembly"
import { registerOmoMcps } from "./register-mcps"
import { registerOmoSessionIndex } from "./register-session-index"
import { registerOmoSkills } from "./register-skills"
import { registerOmoTools } from "./register-tools"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

/**
 * V2 entrypoint.
 *
 * `setup(ctx)` assembles omo's agents, tools, hooks, MCP servers and slash commands, injecting them
 * through the matching `ctx.<domain>.transform`.
 * Registration is best-effort: a config-load or assembly failure is logged and
 * swallowed so the host can always load the plugin (P0 loadability contract).
 */
export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup(ctx) {
      try {
        const pluginConfig = loadPluginConfig(ctx.location.directory, ctx)
        await registerOmoAgents(ctx, pluginConfig)
        await registerOmoTools(ctx, pluginConfig)
        await registerOmoHooks(ctx, pluginConfig)
        await registerOmoMcps(ctx, pluginConfig)
        await registerOmoCommands(ctx, pluginConfig)
        await registerOmoSkills(ctx, pluginConfig)
        await registerOmoSessionIndex(ctx, pluginConfig)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log("[v2] registration skipped", { error: message })
      }
    },
  })
}
