// packages/omo-opencode/src/v2/ask-resolver.test.ts
import { describe, expect, it } from "bun:test"
import { commandProgram, createV2AskResolver } from "./ask-resolver"

describe("commandProgram", () => {
  it("returns the first token of a command", () => {
    expect(commandProgram("bash -c 'echo hi'")).toBe("bash")
    expect(commandProgram("  tail   -f   app.log")).toBe("tail")
  })

  it("returns undefined for an empty command", () => {
    expect(commandProgram("")).toBeUndefined()
    expect(commandProgram("   ")).toBeUndefined()
  })
})

describe("createV2AskResolver", () => {
  const resolver = (allowed: string[]) =>
    createV2AskResolver({ monitor: { enabled: true, allowed_commands: allowed } } as never)

  it("approves a bash command whose program is allowlisted", async () => {
    // given / when / then
    await expect(
      resolver(["bash"])({ permission: "bash", metadata: { command: "bash -c 'echo hi'" } }),
    ).resolves.toBeUndefined()
  })

  it("denies a bash command outside the allowlist and says why", async () => {
    // given a resolver whose allowlist does not contain the program
    const ask = resolver(["tail"])

    // when / then
    await expect(ask({ permission: "bash", metadata: { command: "rm -rf /tmp/x" } })).rejects.toThrow(
      /monitor\.allowed_commands/,
    )
  })

  it("denies everything when no allowlist is configured", async () => {
    // given the default (feature enabled, no allowlist)
    const ask = createV2AskResolver({ monitor: { enabled: true } } as never)

    // when / then - the documented fail-closed behaviour
    await expect(ask({ permission: "bash", metadata: { command: "bash -c 'echo hi'" } })).rejects.toThrow(
      /monitor\.allowed_commands/,
    )
  })

  it("denies a bash ask that carries no command at all", async () => {
    await expect(resolver(["bash"])({ permission: "bash", metadata: {} })).rejects.toThrow(/unknown/)
  })

  it("denies non-bash permissions instead of silently granting them", async () => {
    // given the omo skill tool's ask
    // when / then
    await expect(resolver(["bash"])({ permission: "skill", patterns: ["git-master"] })).rejects.toThrow(
      /no interactive permission prompt/,
    )
  })
})
