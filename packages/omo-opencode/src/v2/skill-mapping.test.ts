// packages/omo-opencode/src/v2/skill-mapping.test.ts
import { describe, expect, it } from "bun:test"
import type { BuiltinSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import {
  dedupeV2SkillsById,
  toV2SkillInfoFromBuiltin,
  toV2SkillInfoFromLoaded,
  virtualSkillPath,
} from "./skill-mapping"

function builtin(overrides: Partial<BuiltinSkill> = {}): BuiltinSkill {
  return { name: "git-master", description: "Git workflow", template: "GIT BODY", ...overrides }
}

function loaded(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: "shared-skill",
    path: "/bundle/skills/shared-skill/SKILL.md",
    definition: { name: "shared-skill", description: "wrapped", template: "wrapped" },
    scope: "shared",
    ...overrides,
  }
}

describe("virtualSkillPath", () => {
  it("is absolute and namespaced so it cannot collide with the host's /builtin paths", () => {
    expect(virtualSkillPath("git-master")).toBe("/omo-builtin/git-master.md")
  })
})

describe("toV2SkillInfoFromBuiltin", () => {
  it("maps a compiled skill onto the V2 shape", () => {
    expect(toV2SkillInfoFromBuiltin(builtin())).toEqual({
      id: "git-master",
      name: "git-master",
      description: "Git workflow",
      path: "/omo-builtin/git-master.md",
      content: "GIT BODY",
    })
  })

  it("omits the description and autoinvoke keys when there is nothing to say", () => {
    // given a builtin with no description
    const info = toV2SkillInfoFromBuiltin(builtin({ description: "" }))

    // then the host's optionalKey fields are absent, not undefined
    expect(Object.keys(info).sort()).toEqual(["content", "id", "name", "path"])
  })

  it("ignores resolvedPath: the compiled bundle does not ship those directories", () => {
    // given a builtin whose resolvedPath points outside the bundle
    const info = toV2SkillInfoFromBuiltin(builtin({ resolvedPath: "/plugins/dev-browser" }))

    // then the virtual path is used, because the content does not come from that directory
    expect(info.path).toBe("/omo-builtin/git-master.md")
  })
})

describe("toV2SkillInfoFromLoaded", () => {
  it("reads the raw SKILL.md body instead of the V1 wrapped template", () => {
    // given a SKILL.md with frontmatter and a body
    const readFile = () => "---\nname: shared-skill\ndescription: From frontmatter\n---\n\nRAW BODY\n$ARGUMENTS stays literal\n"

    // when
    const info = toV2SkillInfoFromLoaded(loaded(), readFile)

    // then the wrapper and the placeholder are gone
    expect(info).toEqual({
      id: "shared-skill",
      name: "shared-skill",
      description: "From frontmatter",
      path: "/bundle/skills/shared-skill/SKILL.md",
      content: "\nRAW BODY\n$ARGUMENTS stays literal\n",
    })
  })

  it("falls back to the discovered name when the frontmatter has none", () => {
    const info = toV2SkillInfoFromLoaded(loaded(), () => "no frontmatter here\n")
    expect(info?.name).toBe("shared-skill")
    expect(info?.id).toBe("shared-skill")
    expect(info?.description).toBeUndefined()
    expect(info?.content).toBe("no frontmatter here\n")
  })

  it("drops a skill with no path", () => {
    expect(toV2SkillInfoFromLoaded(loaded({ path: undefined }), () => "x")).toBeUndefined()
  })

  it("drops a skill whose file cannot be read rather than registering a wrapped template", () => {
    const readFile = () => {
      throw new Error("ENOENT")
    }
    expect(toV2SkillInfoFromLoaded(loaded(), readFile)).toBeUndefined()
  })
})

describe("dedupeV2SkillsById", () => {
  it("keeps the first occurrence so builtins beat the shared bundle", () => {
    // given a builtin and a same-named disk skill, builtin first
    const infos = [
      toV2SkillInfoFromBuiltin(builtin()),
      toV2SkillInfoFromLoaded(loaded({ name: "git-master" }), () => "---\nname: git-master\n---\nDISK"),
    ]

    // when
    const unique = dedupeV2SkillsById(infos.flatMap((info) => (info ? [info] : [])))

    // then
    expect(unique).toHaveLength(1)
    expect(unique[0].path).toBe("/omo-builtin/git-master.md")
  })
})
