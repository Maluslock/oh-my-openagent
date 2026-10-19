// packages/omo-opencode/src/v2/register-skills.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuiltinSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills"
import type { LoadedSkill } from "../features/opencode-skill-loader/types"
import { registerOmoSkills, resetOmoSkillCache } from "./register-skills"

type Added = { id: string; path: string; content: string }

const workDir = mkdtempSync(join(tmpdir(), "omo-skill-registrar-"))
const sharedSkillFile = join(workDir, "shared-skill.md")
writeFileSync(sharedSkillFile, "---\nname: shared-skill\ndescription: From disk\n---\n\nDISK BODY\n")

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function builtin(overrides: Partial<BuiltinSkill> = {}): BuiltinSkill {
  return { name: "git-master", description: "Git", template: "GIT", ...overrides }
}

function sharedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: "shared-skill",
    path: sharedSkillFile,
    definition: { name: "shared-skill", description: "wrapped", template: "wrapped" },
    scope: "shared",
    ...overrides,
  }
}

function createFixture() {
  const added: Added[] = []
  const resolveCalls: unknown[] = []

  const makeCtx = (directory: string) => ({
    location: { directory },
    skill: {
      transform: async (callback: (editor: { add: (skill: Added) => void }) => void) => {
        callback({
          add: (skill) => {
            added.push({ id: skill.id, path: skill.path, content: skill.content })
          },
        })
        return { dispose: async () => {} }
      },
    },
  })

  const deps = {
    resolveActiveBuiltinSkills: ((options: unknown) => {
      resolveCalls.push(options)
      return [builtin()]
    }) as never,
    discoverSharedSkills: (async () => [sharedSkill()]) as never,
    discoverConfigSourceSkills: (async () => []) as never,
  }

  return { makeCtx, deps, added, resolveCalls }
}

beforeEach(() => {
  resetOmoSkillCache()
})

describe("registerOmoSkills", () => {
  it("registers builtin and disk skills through the V2 editor", async () => {
    // given / when
    const { makeCtx, deps, added } = createFixture()
    await registerOmoSkills(makeCtx("/work") as never, {} as never, deps)

    // then the compiled skill gets a virtual path and the disk skill keeps its real one
    expect(added.map((skill) => skill.id).sort()).toEqual(["git-master", "shared-skill"])
    expect(added.find((skill) => skill.id === "git-master")?.path).toBe("/omo-builtin/git-master.md")
    expect(added.find((skill) => skill.id === "git-master")?.content).toBe("GIT")
    expect(added.find((skill) => skill.id === "shared-skill")?.path).toBe(sharedSkillFile)
    expect(added.find((skill) => skill.id === "shared-skill")?.content).toContain("DISK BODY")
  })

  it("passes the browser, team-mode and system-MCP options to the builtin resolver", async () => {
    // given
    const { makeCtx, deps, resolveCalls } = createFixture()

    // when
    await registerOmoSkills(
      makeCtx("/work") as never,
      {
        browser_automation_engine: { provider: "agent-browser" },
        team_mode: { enabled: true },
      } as never,
      deps,
    )

    // then
    const options = resolveCalls[0] as { browserProvider: string; teamModeEnabled: boolean; systemMcpNames: Set<string> }
    expect(options.browserProvider).toBe("agent-browser")
    expect(options.teamModeEnabled).toBe(true)
    expect(options.systemMcpNames).toBeInstanceOf(Set)
  })

  it("keeps the builtin copy when the shared bundle has the same name", async () => {
    // given a shared bundle entry whose frontmatter name collides with a builtin
    const collisionFile = join(workDir, "git-master-collision.md")
    writeFileSync(collisionFile, "---\nname: git-master\n---\n\nDISK GIT MASTER\n")
    const { makeCtx, added } = createFixture()
    const deps = {
      resolveActiveBuiltinSkills: (() => [builtin()]) as never,
      discoverSharedSkills: (async () => [
        sharedSkill({ name: "git-master", path: collisionFile }),
      ]) as never,
      discoverConfigSourceSkills: (async () => []) as never,
    }

    // when
    await registerOmoSkills(makeCtx("/work") as never, {} as never, deps)

    // then
    expect(added).toHaveLength(1)
    expect(added[0].path).toBe("/omo-builtin/git-master.md")
    expect(added[0].content).toBe("GIT")
  })

  it("drops skills disabled through omo config", async () => {
    // given a config that disables the builtin skill
    const { makeCtx, deps, added } = createFixture()

    // when
    await registerOmoSkills(makeCtx("/work") as never, { disabled_skills: ["git-master"] } as never, deps)

    // then
    expect(added.map((skill) => skill.id)).toEqual(["shared-skill"])
  })

  it("drops a disk skill whose file cannot be read instead of faking content", async () => {
    // given a discovered skill pointing at a missing file
    const { makeCtx, added } = createFixture()
    const deps = {
      resolveActiveBuiltinSkills: (() => [builtin()]) as never,
      discoverSharedSkills: (async () => [sharedSkill({ path: join(workDir, "absent.md") })]) as never,
      discoverConfigSourceSkills: (async () => []) as never,
    }

    // when
    await registerOmoSkills(makeCtx("/work") as never, {} as never, deps)

    // then only the builtin survives; nothing carries the V1 wrapped template
    expect(added.map((skill) => skill.id)).toEqual(["git-master"])
  })

  it("registers config-source skills alongside the shared bundle", async () => {
    // given a skill declared through omo's own config
    const configSkillFile = join(workDir, "config-skill.md")
    writeFileSync(configSkillFile, "---\nname: config-skill\n---\n\nCONFIG BODY\n")
    const { makeCtx, added } = createFixture()
    const deps = {
      resolveActiveBuiltinSkills: (() => []) as never,
      discoverSharedSkills: (async () => []) as never,
      discoverConfigSourceSkills: (async () => [
        sharedSkill({ name: "config-skill", path: configSkillFile, scope: "config" }),
      ]) as never,
    }

    // when
    await registerOmoSkills(makeCtx("/work") as never, {} as never, deps)

    // then
    expect(added).toHaveLength(1)
    expect(added[0].id).toBe("config-skill")
    expect(added[0].path).toBe(configSkillFile)
    expect(added[0].content).toContain("CONFIG BODY")
  })

  it("is idempotent for the same context", async () => {
    // given
    const { makeCtx, deps, added } = createFixture()
    const ctx = makeCtx("/work")

    // when
    await registerOmoSkills(ctx as never, {} as never, deps)
    await registerOmoSkills(ctx as never, {} as never, deps)

    // then
    expect(added).toHaveLength(2)
  })

  it("skips registration when the V2 skill domain is unavailable", async () => {
    // given / when
    const { deps, added } = createFixture()
    await registerOmoSkills({ location: { directory: "/work" } } as never, {} as never, deps)

    // then
    expect(added).toHaveLength(0)
  })
})
