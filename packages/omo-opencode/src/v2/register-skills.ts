// packages/omo-opencode/src/v2/register-skills.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { getSystemMcpServerNames } from "../features/claude-code-mcp-loader"
import { resolveActiveBuiltinSkills, type BuiltinSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills"
import {
  collectDisabledSkillAliases,
  discoverConfigSourceSkills,
  discoverSharedSkills,
  normalizeSkillAliasName,
} from "../features/opencode-skill-loader"
import { log } from "../shared"
import {
  dedupeV2SkillsById,
  toV2SkillInfoFromBuiltin,
  toV2SkillInfoFromLoaded,
  type V2SkillInfo,
} from "./skill-mapping"
import { omoRuntimeKeyFor } from "./register-tools"

type V2Setup = NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>
type V2Context = Parameters<V2Setup>[0]

/**
 * Register the skills omo owns into the V2 skill domain.
 *
 * Only sources the V2 host cannot discover by itself are registered:
 *
 * - builtin skills, whose directives are compiled into the plugin;
 * - the shared SKILL.md bundle, which lives inside `@oh-my-opencode/shared-skills` in `node_modules`
 *   and is therefore not under any directory the host scans;
 * - skills declared through omo's own `skills` config (`paths` / `sources`).
 *
 * Measured against opencode 2.0.11 (see `.omo/evidence/20260923-v2-alignment/live-skill-audit.md`):
 * the host discovers `.opencode/skills`, `.claude/skills` and `.agents/skills` natively, plus its own
 * two built-ins, so user/project/Claude skills are NOT re-registered here. In the same measurement,
 * `editor.get(id)` returned `undefined` for a skill the host had already discovered and `add` with a
 * duplicate id did not override it, so there is nothing to guard against: the host's copy wins.
 */

export type RegisterSkillDeps = {
  readonly resolveActiveBuiltinSkills?: typeof resolveActiveBuiltinSkills
  readonly discoverSharedSkills?: typeof discoverSharedSkills
  readonly discoverConfigSourceSkills?: typeof discoverConfigSourceSkills
}

const registeredKeys = new Set<string>()

/** Test seam: clears the memoized skill registrations (production never calls this). */
export function resetOmoSkillCache(): void {
  registeredKeys.clear()
}

/**
 * The builtin skills the current config activates.
 *
 * Shared with the command registrar, which exposes the same skills as slash commands: the two must
 * agree, or a skill command could exist for a skill that is disabled (or the reverse).
 */
export function resolveConfiguredBuiltinSkills(
  pluginConfig: OhMyOpenCodeConfig,
  resolve: typeof resolveActiveBuiltinSkills = resolveActiveBuiltinSkills,
): BuiltinSkill[] {
  return resolve({
    browserProvider: pluginConfig.browser_automation_engine?.provider ?? "playwright",
    disabledSkills: collectDisabledSkillAliases(pluginConfig),
    teamModeEnabled: pluginConfig.team_mode?.enabled ?? false,
    playwrightMcpArgs: pluginConfig.browser_automation_engine?.playwright_mcp_args,
    systemMcpNames: getSystemMcpServerNames(),
  })
}

export async function registerOmoSkills(
  ctx: V2Context,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterSkillDeps = {},
): Promise<void> {
  const skillDomain = ctx.skill
  if (typeof skillDomain?.transform !== "function") {
    log("[v2] skill registration skipped", { reason: "ctx.skill.transform unavailable" })
    return
  }

  const key = omoRuntimeKeyFor(ctx, pluginConfig)
  if (registeredKeys.has(key)) return

  const directory = ctx.location.directory
  const disabledSkills = collectDisabledSkillAliases(pluginConfig)

  const resolveBuiltins = deps.resolveActiveBuiltinSkills ?? resolveActiveBuiltinSkills
  const builtins = resolveConfiguredBuiltinSkills(pluginConfig, resolveBuiltins).map(toV2SkillInfoFromBuiltin)

  const discoverShared = deps.discoverSharedSkills ?? discoverSharedSkills
  const discoverConfigSource = deps.discoverConfigSourceSkills ?? discoverConfigSourceSkills
  const [shared, configSource] = await Promise.all([
    discoverShared(),
    discoverConfigSource({ config: pluginConfig.skills, configDir: directory }),
  ])

  const fromDisk: V2SkillInfo[] = []
  let unreadable = 0
  for (const skill of [...shared, ...configSource]) {
    const mapped = toV2SkillInfoFromLoaded(skill)
    if (mapped === undefined) {
      unreadable += 1
      continue
    }
    fromDisk.push(mapped)
  }

  const merged = dedupeV2SkillsById([...builtins, ...fromDisk])
  const candidates = merged.filter((skill) => !disabledSkills.has(normalizeSkillAliasName(skill.name)))
  const disabledCount = merged.length - candidates.length

  await skillDomain.transform((editor) => {
    for (const skill of candidates) editor.add(skill)
  })

  registeredKeys.add(key)
  log("[v2] skills registered", {
    registered: candidates.length,
    builtin: builtins.length,
    fromDisk: fromDisk.length,
    disabled: disabledCount,
    unreadable,
    names: candidates.map((skill) => skill.id),
  })
}
