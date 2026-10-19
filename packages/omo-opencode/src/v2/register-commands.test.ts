// packages/omo-opencode/src/v2/register-commands.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import type { CommandDefinition as V1CommandDefinition } from "../features/claude-code-command-loader"
import { registerOmoCommands, resetOmoCommandCache } from "./register-commands"

type LoadArgs = { disabled: unknown; options: unknown }

function createFixture() {
  const added: { name: string; description?: string }[] = []
  const promptCalls: Record<string, unknown>[] = []
  const switchCalls: { sessionID: string; agent: string }[] = []
  const loadArgs: LoadArgs[] = []
  const executed = new Map<string, (invocation: unknown) => Promise<void>>()

  const commands: Record<string, V1CommandDefinition> = {
    goal: { name: "goal", description: "(builtin) Set the goal", template: "GOAL $ARGUMENTS" },
    "remove-ai-slops": {
      name: "remove-ai-slops",
      description: "(builtin) Remove AI slops",
      template: "SLOP COMMAND $ARGUMENTS",
    },
    "start-work": {
      name: "start-work",
      description: "(builtin) Start Atlas work session",
      template: "START $SESSION_ID $TIMESTAMP",
      agent: "atlas",
    },
  }

  const makeCtx = (directory: string) => ({
    location: { directory },
    command: {
      transform: async (
        callback: (editor: { add: (definition: { name: string; description?: string; execute: (i: unknown) => Promise<void> }) => void }) => void,
      ) => {
        callback({
          add: (definition) => {
            added.push({ name: definition.name, description: definition.description })
            executed.set(definition.name, definition.execute)
          },
        })
        return { dispose: async () => {} }
      },
    },
    session: {
      prompt: async (payload: Record<string, unknown>) => {
        promptCalls.push(payload)
        return { id: "msg_test" }
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        switchCalls.push(input)
      },
    },
  })

  const deps = {
    loadBuiltinCommands: ((disabled: unknown, options: unknown) => {
      loadArgs.push({ disabled, options })
      return commands
    }) as never,
    resolveBuiltinSkills: (() => [
      { name: "git-master", description: "Git workflow", template: "GIT SKILL BODY" },
      { name: "remove-ai-slops", description: "skill copy", template: "SKILL SLOP BODY" },
    ]) as never,
  }

  return { makeCtx, deps, added, executed, promptCalls, switchCalls, loadArgs }
}

beforeEach(() => {
  resetOmoCommandCache()
})

describe("registerOmoCommands", () => {
  it("adds every built-in command through the V2 editor", async () => {
    // given
    const { makeCtx, deps, added } = createFixture()

    // when
    await registerOmoCommands(makeCtx("/work") as never, {} as never, deps)

    // then builtin skill commands come first, then the real builtin commands
    expect(added.map((entry) => entry.name)).toEqual(["git-master", "remove-ai-slops", "goal", "start-work"])
    // the skill command is not what wins for a name both sources provide
    expect(added.find((entry) => entry.name === "remove-ai-slops")?.description).not.toBe("skill copy")
    expect(added.find((entry) => entry.name === "git-master")?.description).toBe("Git workflow")
  })

  it("lets a real builtin command win over a same-named skill command", async () => {
    // given a skill and a command both named remove-ai-slops
    const { makeCtx, deps, executed, promptCalls } = createFixture()

    // when
    await registerOmoCommands(makeCtx("/work") as never, {} as never, deps)
    await executed.get("remove-ai-slops")!({ sessionID: "ses_1", prompt: { text: "x" }, delivery: "steer" })

    // then the command's own template is delivered, not the skill wrapper body
    const delivered = String(promptCalls[0].text)
    expect(delivered).toBe("SLOP COMMAND x")
    expect(delivered).not.toContain("SKILL SLOP BODY")
  })

  it("drops a skill command named in disabled_commands", async () => {
    // given
    const { makeCtx, deps, added } = createFixture()

    // when
    await registerOmoCommands(makeCtx("/work") as never, { disabled_commands: ["git-master"] } as never, deps)

    // then
    expect(added.map((entry) => entry.name)).not.toContain("git-master")
  })

  it("loads commands with the V1 options so /start-work still prefers atlas", async () => {
    // given
    const { makeCtx, deps, loadArgs } = createFixture()

    // when
    await registerOmoCommands(makeCtx("/work") as never, { disabled_commands: ["hyperplan"] } as never, deps)

    // then
    expect(loadArgs).toEqual([
      { disabled: ["hyperplan"], options: { useRegisteredAgents: true, teamModeEnabled: false } },
    ])
  })

  it("passes the team-mode flag through to the command loader", async () => {
    // given
    const { makeCtx, deps, loadArgs } = createFixture()

    // when
    await registerOmoCommands(makeCtx("/work") as never, { team_mode: { enabled: true } } as never, deps)

    // then
    expect(loadArgs[0].options).toEqual({ useRegisteredAgents: true, teamModeEnabled: true })
  })

  it("executes a command once, delivering the expanded template", async () => {
    // given
    const { makeCtx, deps, executed, promptCalls, switchCalls } = createFixture()
    await registerOmoCommands(makeCtx("/work") as never, {} as never, deps)

    // when
    await executed.get("goal")!({ sessionID: "ses_1", prompt: { text: "ship it" }, delivery: "steer" })

    // then
    expect(promptCalls).toEqual([{ sessionID: "ses_1", text: "GOAL ship it", delivery: "steer" }])
    expect(switchCalls).toHaveLength(0)
  })

  it("switches the agent declared by the command before delivering", async () => {
    // given
    const { makeCtx, deps, executed, switchCalls } = createFixture()
    await registerOmoCommands(makeCtx("/work") as never, {} as never, deps)

    // when
    await executed.get("start-work")!({ sessionID: "ses_1", prompt: { text: "" }, delivery: "queue" })

    // then
    expect(switchCalls).toEqual([{ sessionID: "ses_1", agent: "atlas" }])
  })

  it("is idempotent for the same context", async () => {
    // given
    const { makeCtx, deps, added } = createFixture()
    const ctx = makeCtx("/work")

    // when
    await registerOmoCommands(ctx as never, {} as never, deps)
    await registerOmoCommands(ctx as never, {} as never, deps)

    // then
    expect(added).toHaveLength(4)
  })

  it("skips registration when the V2 command domain is unavailable", async () => {
    // given
    const { deps, added } = createFixture()

    // when
    await registerOmoCommands({ location: { directory: "/work" } } as never, {} as never, deps)

    // then
    expect(added).toHaveLength(0)
  })

  it("skips registration when the session domain cannot deliver", async () => {
    // given
    const { makeCtx, deps, added } = createFixture()
    const ctx = makeCtx("/work") as Record<string, unknown>
    delete ctx.session

    // when
    await registerOmoCommands(ctx as never, {} as never, deps)

    // then
    expect(added).toHaveLength(0)
  })
})
