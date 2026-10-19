// packages/omo-opencode/src/v2/command-mapping.test.ts
import { describe, expect, it } from "bun:test"
import type { CommandDefinition as V1CommandDefinition } from "../features/claude-code-command-loader"
import {
  expandCommandTemplate,
  toV2CommandDefinitions,
  type CommandDeliveryInput,
  type V2CommandInvocation,
} from "./command-mapping"

function createInvocation(overrides: Partial<V2CommandInvocation> = {}): V2CommandInvocation {
  return {
    sessionID: "ses_test",
    prompt: { text: "user text" },
    delivery: "steer",
    ...overrides,
  } as V2CommandInvocation
}

function v1Command(overrides: Partial<V1CommandDefinition> = {}): V1CommandDefinition {
  return { name: "goal", template: "do $ARGUMENTS", ...overrides }
}

describe("expandCommandTemplate", () => {
  it("substitutes the three placeholders the V1 host expanded", () => {
    // given
    const template = "id=$SESSION_ID at=$TIMESTAMP args=$ARGUMENTS"

    // when
    const expanded = expandCommandTemplate(template, {
      arguments: "build it",
      sessionID: "ses_1",
      timestamp: "2026-09-23T00:00:00.000Z",
    })

    // then
    expect(expanded).toBe("id=ses_1 at=2026-09-23T00:00:00.000Z args=build it")
  })

  it("does not re-expand placeholders that arrive inside the user's arguments", () => {
    // given
    const template = "$ARGUMENTS"

    // when
    const expanded = expandCommandTemplate(template, {
      arguments: "keep $SESSION_ID and $TIMESTAMP literal",
      sessionID: "ses_1",
      timestamp: "2026-09-23T00:00:00.000Z",
    })

    // then
    expect(expanded).toBe("keep $SESSION_ID and $TIMESTAMP literal")
  })

  it("leaves a template with no placeholders untouched", () => {
    expect(
      expandCommandTemplate("BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD)", {
        arguments: "ignored",
        sessionID: "ses_1",
        timestamp: "2026-09-23T00:00:00.000Z",
      }),
    ).toBe("BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD)")
  })

  it("substitutes every occurrence, not only the first", () => {
    expect(
      expandCommandTemplate("$TIMESTAMP then $TIMESTAMP", {
        arguments: "",
        sessionID: "ses_1",
        timestamp: "T",
      }),
    ).toBe("T then T")
  })
})

describe("toV2CommandDefinitions", () => {
  it("maps name and description onto the V2 definition shape", () => {
    // given
    const commands = { goal: v1Command({ description: "(builtin) Set the goal" }) }

    // when
    const definitions = toV2CommandDefinitions(commands, async () => {})

    // then
    expect(definitions).toHaveLength(1)
    expect(definitions[0].name).toBe("goal")
    expect(definitions[0].description).toBe("(builtin) Set the goal")
  })

  it("omits description entirely when the V1 command has none", () => {
    // given / when
    const definitions = toV2CommandDefinitions({ goal: v1Command() }, async () => {})

    // then
    expect(Object.keys(definitions[0]).sort()).toEqual(["execute", "name"])
  })

  it("drops V1-only fields that the V2 editor cannot express", () => {
    // given
    const commands = {
      refactor: v1Command({
        name: "refactor",
        argumentHint: "<target>",
        model: "deepseek/deepseek-v4-pro",
        subtask: true,
        handoffs: [{ label: "next", agent: "atlas", prompt: "go" }],
      }),
    }

    // when
    const definitions = toV2CommandDefinitions(commands, async () => {})

    // then
    expect(Object.keys(definitions[0]).sort()).toEqual(["execute", "name"])
  })

  it("expands the template and hands the result to the injected deliverer", async () => {
    // given
    const delivered: CommandDeliveryInput[] = []
    const definitions = toV2CommandDefinitions(
      { goal: v1Command({ template: "session=$SESSION_ID\n$ARGUMENTS", agent: "atlas" }) },
      async (input) => {
        delivered.push(input)
      },
      () => new Date("2026-09-23T01:02:03.000Z"),
    )

    // when
    await definitions[0].execute(createInvocation({ prompt: { text: "ship it" } } as V2CommandInvocation))

    // then
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe("session=ses_test\nship it")
    expect(delivered[0].command.agent).toBe("atlas")
  })

  it("forwards the invocation untouched so delivery and attachments survive", async () => {
    // given
    const delivered: CommandDeliveryInput[] = []
    const definitions = toV2CommandDefinitions({ goal: v1Command() }, async (input) => {
      delivered.push(input)
    })
    const invocation = createInvocation({
      delivery: "queue",
      prompt: { text: "queued", files: [{ uri: "file:///tmp/a.ts" }] },
    } as V2CommandInvocation)

    // when
    await definitions[0].execute(invocation)

    // then
    expect(delivered[0].invocation).toBe(invocation)
    expect(delivered[0].invocation.delivery).toBe("queue")
    expect(delivered[0].invocation.prompt.files).toEqual([{ uri: "file:///tmp/a.ts" }])
  })

  it("skips commands whose template is missing or empty", () => {
    // given
    const commands = {
      good: v1Command(),
      missing: { name: "missing" } as V1CommandDefinition,
      empty: { name: "empty", template: "" },
    }

    // when
    const definitions = toV2CommandDefinitions(commands, async () => {})

    // then
    expect(definitions.map((definition) => definition.name)).toEqual(["good"])
  })
})
