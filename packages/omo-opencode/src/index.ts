import type { PluginModule } from "@opencode-ai/plugin"
import { createPluginModule } from "./testing/create-plugin-module"
import { createV2Plugin } from "./v2/create-v2-plugin"

const pluginModule: PluginModule = createPluginModule()

/** V1 entrypoint, kept for `@opencode-ai/plugin` hosts. */
export const omoPlugin = pluginModule.server

/**
 * Dual-version default export.
 * - V1 calls `server(input, options)` and uses the returned hooks.
 * - V2 reads `id` + `setup(ctx)` and ignores `server`.
 */
export default {
  ...pluginModule,
  ...createV2Plugin(),
}

export type {
  AgentName,
  AgentOverrideConfig,
  AgentOverrides,
  BuiltinCommandName,
  HookName,
  McpName,
  OhMyOpenCodeConfig,
} from "./config"

export type { ConfigLoadError } from "./shared/config-errors"
