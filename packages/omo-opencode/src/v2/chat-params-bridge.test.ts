// packages/omo-opencode/src/v2/chat-params-bridge.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import { createChatParamsHandler } from "../plugin/chat-params"
import { clearAllSessionPromptParams, setSessionPromptParams } from "../shared/session-prompt-params-state"
import { applyV1ChatParams, toV1ChatParams } from "./model-request-hook-mapping"

/**
 * The V2 bridge must hand the V1 `chat.params` handler an input the handler accepts. `chat-params.ts`
 * `buildChatParamsInput` rejects an input without a `message` record, and the bridge omitted it, so
 * the entire V1 chain (per-session prompt params stored by the background manager and delegate-task,
 * plus the model-capability clamp) silently did nothing on V2.
 */
const CONTEXT_EVENT = {
  sessionID: "ses_bridge",
  agent: "sisyphus",
  model: { id: "deepseek-v4-pro", providerID: "deepseek", variant: "default" },
  options: {},
}

describe("chat.params bridge -> V1 handler", () => {
  beforeEach(() => {
    clearAllSessionPromptParams()
  })

  it("gives the handler the message record it requires", () => {
    const pair = toV1ChatParams(CONTEXT_EVENT)
    expect(pair?.input.message).toEqual({ variant: "default" })
  })

  it("carries per-session prompt params into the V2 context options", async () => {
    // given params stored for the session, the way the background manager stores them at launch
    setSessionPromptParams("ses_bridge", {
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 12345,
      options: { reasoningEffort: "high" },
    })
    const event = structuredClone(CONTEXT_EVENT) as Record<string, unknown>
    const handler = createChatParamsHandler()

    // when the bridge runs the real V1 handler over the context event
    const pair = toV1ChatParams(event)!
    await handler(pair.input, pair.output)
    applyV1ChatParams(event, pair.output)

    // then every stored setting reaches the V2 options, under V2's names
    expect(event.options).toMatchObject({
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 12345,
      reasoningEffort: "high",
    })
  })
})
