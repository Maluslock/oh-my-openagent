// packages/omo-opencode/src/v2/skill-mapping.ts
import { readFileSync } from "node:fs"
import type { Skill } from "@opencode/plugin"
import type { BuiltinSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { parseFrontmatter } from "../shared/frontmatter"

/**
 * omo skill shapes to the V2 `Skill.Info` shape.
 *
 * V2's `ctx.skill.transform` editor takes `Skill.Info`:
 * `{ id, name, description?, autoinvoke?, path, content }`. Two omo sources feed it:
 *
 * - builtin skills (`BuiltinSkill`): the directive is compiled into the plugin, with no SKILL.md of
 *   its own. Their `path` is a virtual absolute path, the same convention the host uses for its own
 *   built-ins (`/builtin/opencode.md`), because claiming a real file path for compiled content would
 *   be a lie.
 * - skills discovered on disk (`LoadedSkill`, from the shared bundle or omo's own `skills` config):
 *   the real SKILL.md path, with `content` read back as the raw body. The V1 `definition.template`
 *   is NOT suitable here: V1 wrapped it in `<skill-instruction>` plus a `$ARGUMENTS` block and
 *   resolved `@path` references against a base directory, while the host's own disk skills carry the
 *   untouched body.
 *
 * `autoinvoke` is never written: omo has no such concept, and the host declares it with
 * `optionalKey`, which accepts an absent key but not an explicit `undefined`.
 */

export type V2SkillInfo = Skill.Info

export type SkillFileReader = (path: string) => string

const VIRTUAL_SKILL_ROOT = "/omo-builtin"

/** Absolute, intentionally non-existent path for a skill whose content ships inside the plugin. */
export function virtualSkillPath(name: string): string {
  return `${VIRTUAL_SKILL_ROOT}/${name}.md`
}

type PlainSkillInfo = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly content: string
}

/**
 * The host brands `id`, `name` and `path` (`Skill.ID`, `Skill.Name`, `AbsolutePath`) and exports no
 * constructor, so the brands are applied here, at the single boundary where our plain strings become
 * host values.
 */
function toSkillInfo(info: PlainSkillInfo): V2SkillInfo {
  return {
    id: info.id as V2SkillInfo["id"],
    name: info.name as V2SkillInfo["name"],
    ...(info.description !== undefined ? { description: info.description } : {}),
    path: info.path as V2SkillInfo["path"],
    content: info.content,
  }
}

export function toV2SkillInfoFromBuiltin(skill: BuiltinSkill): V2SkillInfo {
  return toSkillInfo({
    id: skill.name,
    name: skill.name,
    ...(skill.description.length > 0 ? { description: skill.description } : {}),
    path: virtualSkillPath(skill.name),
    content: skill.template,
  })
}

/**
 * Map a disk-discovered skill, reading the SKILL.md back for its raw body.
 *
 * Returns `undefined` when the skill has no readable file: a skill whose content cannot be produced
 * is dropped rather than registered with a wrapped template that would inject `$ARGUMENTS` into the
 * model's context.
 */
export function toV2SkillInfoFromLoaded(
  skill: LoadedSkill,
  readFile: SkillFileReader = (path) => readFileSync(path, "utf8"),
): V2SkillInfo | undefined {
  const path = skill.path
  if (typeof path !== "string" || path.length === 0) return undefined

  let raw: string
  try {
    raw = readFile(path)
  } catch {
    return undefined
  }

  const { data, body } = parseFrontmatter<Record<string, unknown>>(raw)
  const frontmatterName = typeof data.name === "string" && data.name.length > 0 ? data.name : undefined
  const name = frontmatterName ?? skill.name
  const description = typeof data.description === "string" && data.description.length > 0
    ? data.description
    : undefined

  return toSkillInfo({
    id: name,
    name,
    ...(description !== undefined ? { description } : {}),
    path,
    content: body,
  })
}

/**
 * Collapse duplicate ids, keeping the FIRST occurrence.
 *
 * Callers pass builtin skills before disk skills, which reproduces V1's `mergeSkills` precedence
 * (`SCOPE_PRIORITY` rates `builtin` and `shared` equal, and the builtin entry is inserted first).
 */
export function dedupeV2SkillsById(skills: readonly V2SkillInfo[]): V2SkillInfo[] {
  const seen = new Set<string>()
  const unique: V2SkillInfo[] = []
  for (const skill of skills) {
    if (seen.has(skill.id)) continue
    seen.add(skill.id)
    unique.push(skill)
  }
  return unique
}
