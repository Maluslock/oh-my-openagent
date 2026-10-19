// packages/omo-opencode/src/v2/command-delivery.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import { clearRegisteredAgentNames, registerAgentName } from "../features/claude-code-session-state"
import type { CommandDefinition as V1CommandDefinition } from "../features/claude-code-command-loader"
import { createCommandDeliver } from "./command-delivery"
import type { V2CommandInvocation } from "./command-mapping"

function createFixture() {
  const calls: string[] = []
  const promptCalls: Record<string, unknown>[] = []
  const switchCalls: { sessionID: string; agent: string }[] = []

  const ctx = {
    session: {
      prompt: async (payload: Record<string, unknown>) => {
        calls.push("prompt")
        promptCalls.push(payload)
        return { id: "msg_test" }
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        calls.push("switchAgent")
        switchCalls.push(input)
      },
    },
  }

  return { ctx, calls, promptCalls, switchCalls }
}

function v1Command(overrides: Partial<V1CommandDefinition> = {}): V1CommandDefinition {
  return { name: "goal", template: "unused", ...overrides }
}

function createInvocation(overrides: Partial<V2CommandInvocation> = {}): V2CommandInvocation {
  return {
    sessionID: "ses_test",
    prompt: { text: "user text" },
    delivery: "steer",
    ...overrides,
  } as V2CommandInvocation
}

describe("createCommandDeliver", () => {
  beforeEach(() => {
    clearRegisteredAgentNames()
  })

  it("posts the expanded text with the caller's delivery", async () => {
    // given
    const { ctx, promptCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)

    // when
    await deliver({ invocation: createInvocation({ delivery: "queue" } as never), command: v1Command(), text: "expanded" })

    // then
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toEqual({ sessionID: "ses_test", text: "expanded", delivery: "queue" })
  })

  it("omits absent optional keys instead of sending explicit undefined", async () => {
    // given
    const { ctx, promptCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)

    // when
    await deliver({ invocation: createInvocation(), command: v1Command(), text: "expanded" })

    // then
    expect(Object.keys(promptCalls[0]).sort()).toEqual(["delivery", "sessionID", "text"])
  })

  it("switches the session agent before posting when the command declares one", async () => {
    // given
    const { ctx, calls, switchCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)

    // when
    await deliver({ invocation: createInvocation(), command: v1Command({ agent: "atlas" }), text: "expanded" })

    // then
    expect(switchCalls).toEqual([{ sessionID: "ses_test", agent: "atlas" }])
    expect(calls).toEqual(["switchAgent", "prompt"])
  })

  it("resolves a config-key agent name to the id the host actually registered", async () => {
    // given omo registered its agents under display ids, as V2 does
    registerAgentName("Atlas - Plan Executor")

    // when
    const { ctx, switchCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)
    await deliver({ invocation: createInvocation(), command: v1Command({ agent: "atlas" }), text: "expanded" })

    // then a command that names the config key switches to the display id
    expect(switchCalls).toEqual([{ sessionID: "ses_test", agent: "Atlas - Plan Executor" }])
  })

  it("does not touch the agent when the command declares none", async () => {
    // given
    const { ctx, calls, switchCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)

    // when
    await deliver({ invocation: createInvocation(), command: v1Command(), text: "expanded" })

    // then
    expect(switchCalls).toHaveLength(0)
    expect(calls).toEqual(["prompt"])
  })

  it("ignores an empty agent string", async () => {
    // given
    const { ctx, switchCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)

    // when
    await deliver({ invocation: createInvocation(), command: v1Command({ agent: "" }), text: "expanded" })

    // then
    expect(switchCalls).toHaveLength(0)
  })

  it("forwards attachments from the invocation", async () => {
    // given
    const { ctx, promptCalls } = createFixture()
    const deliver = createCommandDeliver(ctx as never)
    const invocation = createInvocation({
      prompt: {
        text: "user text",
        files: [{ uri: "file:///tmp/a.ts" }],
        skills: [{ id: "git-master" }],
      },
    } as never)

    // when
    await deliver({ invocation, command: v1Command(), text: "expanded" })

    // then
    expect(promptCalls[0].files).toEqual([{ uri: "file:///tmp/a.ts" }])
    expect(promptCalls[0].skills).toEqual([{ id: "git-master" }])
  })
})
