// packages/omo-opencode/src/v2/prompt-hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { applyV1ChatMessage, toV1ChatMessage, UNMAPPED_MESSAGE_FIELDS } from "./prompt-hook-mapping"

const PROMPT_EVENT = {
  sessionID: "ses_1",
  messageID: "msg_1",
  delivery: "queue",
  prompt: { text: "do the thing", files: [{ data: "", mime: "image/png", source: { type: "uri", uri: "file:///a.png" } }] },
}

describe("toV1ChatMessage", () => {
  it("projects the prompt text and exposes the admission message id", () => {
    expect(toV1ChatMessage(PROMPT_EVENT)).toEqual({
      input: { sessionID: "ses_1" },
      output: { message: { id: "msg_1" }, parts: [{ type: "text", text: "do the thing" }] },
    })
  })

  it("omits the message id when the event has none", () => {
    const pair = toV1ChatMessage({ sessionID: "ses_1", prompt: { text: "x" } })
    expect(pair?.output.message).toEqual({})
  })

  it("returns undefined for malformed events", () => {
    expect(toV1ChatMessage(null)).toBeUndefined()
    expect(toV1ChatMessage({ prompt: { text: "x" } })).toBeUndefined()
    expect(toV1ChatMessage({ sessionID: 1 })).toBeUndefined()
  })

  it("tolerates an absent prompt", () => {
    expect(toV1ChatMessage({ sessionID: "ses_1" })?.output.parts).toEqual([])
    expect(toV1ChatMessage({ sessionID: "ses_1", prompt: {} })?.output.parts).toEqual([])
  })
})

describe("applyV1ChatMessage", () => {
  it("writes mutated parts back onto prompt.text", () => {
    const event = structuredClone(PROMPT_EVENT) as Record<string, unknown>
    const pair = toV1ChatMessage(event)!
    // What the keyword/ultrawork hooks do: prepend a directive part.
    pair.output.parts.unshift({ type: "text", text: "<ultrawork-mode>on</ultrawork-mode>" })
    applyV1ChatMessage(event, pair.output, () => {})

    expect((event.prompt as Record<string, unknown>).text).toBe("<ultrawork-mode>on</ultrawork-mode>\n\ndo the thing")
  })

  it("leaves prompt.text untouched when the handler changed nothing", () => {
    const event = structuredClone(PROMPT_EVENT) as Record<string, unknown>
    const pair = toV1ChatMessage(event)!
    applyV1ChatMessage(event, pair.output, () => {})
    expect((event.prompt as Record<string, unknown>).text).toBe("do the thing")
  })

  it("reports every message-level field the V2 prompt cannot carry", () => {
    const event = structuredClone(PROMPT_EVENT) as Record<string, unknown>
    const pair = toV1ChatMessage(event)!
    pair.output.message.model = { providerID: "anthropic", modelID: "sonnet" }
    pair.output.message.variant = "high"
    pair.output.message.thinking = "high"

    const reported: string[] = []
    applyV1ChatMessage(event, pair.output, (field) => reported.push(field))

    expect(reported).toEqual(["model", "variant", "thinking"])
    expect(UNMAPPED_MESSAGE_FIELDS).toContain("agent")
  })

  it("ignores non-record events and events without a prompt", () => {
    expect(() => applyV1ChatMessage(null, { message: {}, parts: [] }, () => {})).not.toThrow()
    expect(() => applyV1ChatMessage({ sessionID: "ses_1" }, { message: {}, parts: [] }, () => {})).not.toThrow()
  })
})
