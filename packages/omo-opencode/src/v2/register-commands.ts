// packages/omo-opencode/src/v2/register-commands.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { loadBuiltinCommands } from "../features/builtin-commands"
import { builtinSkillsToCommandDefinitionRecord } from "../features/opencode-skill-loader"
import { log } from "../shared"
import { createCommandDeliver } from "./command-delivery"
import { toV2CommandDefinitions } from "./command-mapping"
import { resolveConfiguredBuiltinSkills } from "./register-skills"
import { omoRuntimeKeyFor } from "./register-tools"

type V2Setup = NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>
type V2Context = Parameters<V2Setup>[0]

/**
 * Register omo's built-in slash commands into the V2 command domain.
 *
 * V2 never calls a plugin's `config` hook, so `applyCommandConfig` (the V1 phase that wrote these
 * commands into the host config) never runs. `ctx.command.transform` lets a plugin contribute
 * definitions directly, and each definition's `execute` owns expansion and delivery - see
 * `command-mapping.ts` and `command-delivery.ts`.
 *
 * The command record is built exactly like V1 did (`useRegisteredAgents: true` so `/start-work`
 * prefers atlas, plus the team-mode addenda), and is memoized per runtime key like the other
 * registrars.
 */

export type RegisterCommandDeps = {
  readonly loadBuiltinCommands?: typeof loadBuiltinCommands
  readonly resolveBuiltinSkills?: typeof resolveConfiguredBuiltinSkills
}

const registeredKeys = new Set<string>()

/** Test seam: clears the memoized command registrations (production never calls this). */
export function resetOmoCommandCache(): void {
  registeredKeys.clear()
}

export async function registerOmoCommands(
  ctx: V2Context,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterCommandDeps = {},
): Promise<void> {
  const commandDomain = ctx.command
  if (typeof commandDomain?.transform !== "function") {
    log("[v2] command registration skipped", { reason: "ctx.command.transform unavailable" })
    return
  }

  if (typeof ctx.session?.prompt !== "function" || typeof ctx.session?.switchAgent !== "function") {
    log("[v2] command registration skipped", { reason: "ctx.session.prompt/switchAgent unavailable" })
    return
  }

  const key = omoRuntimeKeyFor(ctx, pluginConfig)
  if (registeredKeys.has(key)) return

  const loadCommands = deps.loadBuiltinCommands ?? loadBuiltinCommands
  const teamModeEnabled = pluginConfig.team_mode?.enabled ?? false
  const builtin = loadCommands(pluginConfig.disabled_commands, {
    useRegisteredAgents: true,
    teamModeEnabled,
  })

  // V1 also exposed every builtin skill as a slash command (`/git-master`, `/review-work`, ...), and
  // spread those FIRST so a real command of the same name wins. `remove-ai-slops` and `init-deep`
  // exist as both, which is exactly the collision that ordering resolves.
  const disabledCommands = new Set<string>(pluginConfig.disabled_commands ?? [])
  const resolveSkills = deps.resolveBuiltinSkills ?? resolveConfiguredBuiltinSkills
  const skillCommands = builtinSkillsToCommandDefinitionRecord(resolveSkills(pluginConfig))
  const enabledSkillCommands = Object.fromEntries(
    Object.entries(skillCommands).filter(([name]) => !disabledCommands.has(name)),
  )

  const definitions = toV2CommandDefinitions({ ...enabledSkillCommands, ...builtin }, createCommandDeliver(ctx))
  const names = definitions.map((definition) => definition.name)

  await commandDomain.transform((editor) => {
    for (const definition of definitions) editor.add(definition)
  })

  registeredKeys.add(key)
  log("[v2] commands registered", { registered: definitions.length, names })
}
