// packages/omo-opencode/src/v2/request-message-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { createToolPairValidatorHook } from "../hooks/tool-pair-validator"
import {
  createRequestMessageOrigins,
  fromV1RequestMessages,
  toV1RequestMessages,
  v1ContentFromV2Result,
} from "./request-message-mapping"

/**
 * The shape opencode V2 actually sends: the tool call is in the assistant message and its result is
 * in the NEXT message. The fixture above keeps both in one message, which is what made a
 * per-message result lookup look correct.
 */
const V2_SPLIT_TOOL_MESSAGES = [
  {
    id: "msg_a1",
    role: "assistant",
    content: [{ type: "tool-call", id: "call_1", name: "glob", input: { pattern: "*.md" } }],
  },
  {
    id: "msg_u2",
    role: "user",
    content: [
      {
        type: "tool-result",
        id: "call_1",
        name: "glob",
        result: { type: "content", value: [{ type: "text", text: "1 match" }] },
      },
    ],
  },
]

const V2_MESSAGES = [
  {
    id: "msg_u1",
    role: "user",
    content: [{ type: "text", text: "hello", cache: { type: "ephemeral" } }],
    providerMetadata: { keep: true },
  },
  {
    id: "msg_a1",
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
      { type: "tool-call", id: "call_1", name: "grep", input: { pattern: "x" } },
      { type: "tool-result", id: "call_1", name: "grep", result: { type: "content", value: [{ type: "text", text: "match" }] } },
      { type: "tool-call", id: "call_2", name: "bash", input: { command: "ls" } },
      { type: "media", mediaType: "image/png", data: "QUJD" },
    ],
  },
]

describe("toV1RequestMessages", () => {
  it("maps text, reasoning and both tool states onto the V1 contract", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)

    expect(v1.map((message) => message.info)).toEqual([
      { role: "user", id: "msg_u1", sessionID: "ses_1" },
      { role: "assistant", id: "msg_a1", sessionID: "ses_1" },
    ])

    const parts = v1[1]!.parts
    expect(parts[0]).toEqual({ type: "reasoning", text: "thinking" })
    expect(parts[1]).toEqual({ type: "text", text: "answer" })
    // call_1 has a matching result -> terminal ("completed"), so the validator ignores it.
    expect(parts[2]).toEqual({
      type: "tool",
      callID: "call_1",
      tool: "grep",
      state: { status: "completed", input: { pattern: "x" } },
    })
    // call_2 has no result -> non-terminal ("running"), so the validator repairs it.
    expect(parts[4]).toEqual({
      type: "tool",
      callID: "call_2",
      tool: "bash",
      state: { status: "running", input: { command: "ls" } },
    })
    expect(parts[3]).toEqual({
      type: "tool_result",
      toolUseId: "call_1",
      tool_use_id: "call_1",
      content: [{ type: "text", text: "match" }],
    })
  })

  it("passes untouched part kinds through by identity", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    const media = v1[1]!.parts[5]
    expect(media).toBe(V2_MESSAGES[1]!.content[5])
  })

  it("returns an empty list for malformed input", () => {
    const origins = createRequestMessageOrigins()
    expect(toV1RequestMessages(null, "ses_1", origins)).toEqual([])
    expect(toV1RequestMessages([1, "x"], "ses_1", origins)).toEqual([])
  })
})

describe("fromV1RequestMessages", () => {
  it("round-trips unchanged messages while preserving origin-only fields", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    const roundTripped = fromV1RequestMessages(v1, origins)

    expect(roundTripped[0]).toEqual({ ...V2_MESSAGES[0] })
    const assistant = roundTripped[1]!
    expect((assistant.content as unknown[])[0]).toEqual({ type: "reasoning", text: "thinking" })
    expect((assistant.content as unknown[])[1]).toEqual({ type: "text", text: "answer" })
    // Origin-only fields survive (the user message's providerMetadata).
    expect((roundTripped[0] as Record<string, unknown>).providerMetadata).toEqual({ keep: true })
  })

  it("merges handler mutations back into the origin part (keeps cache/metadata)", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    const textPart = v1[0]!.parts[0] as Record<string, unknown>
    textPart.text = "hello (mutated)"

    const roundTripped = fromV1RequestMessages(v1, origins)
    const content = (roundTripped[0] as Record<string, unknown>).content as Record<string, unknown>[]
    expect(content[0]).toEqual({ type: "text", text: "hello (mutated)", cache: { type: "ephemeral" } })
  })

  it("converts a synthetic tool_result inserted by the validator into a V2 tool-result", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    // This is exactly what hooks/tool-pair-validator/tool-result-repair.ts inserts.
    v1[1]!.parts.push({
      type: "tool_result",
      toolUseId: "call_2",
      tool_use_id: "call_2",
      isError: true,
      content: [{ type: "text", text: "[tool result missing]" }],
    })

    const content = (fromV1RequestMessages(v1, origins)[1] as Record<string, unknown>).content as Record<string, unknown>[]
    const inserted = content[content.length - 1]!
    expect(inserted).toEqual({
      type: "tool-result",
      id: "call_2",
      name: "bash",
      result: { type: "error", value: "[tool result missing]" },
    })
  })

  it("converts a synthetic text part into a V2 text part", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    v1[0]!.parts.push({ type: "text", text: "<category-skill-reminder>" })

    const content = (fromV1RequestMessages(v1, origins)[0] as Record<string, unknown>).content as Record<string, unknown>[]
    expect(content[1]).toEqual({ type: "text", text: "<category-skill-reminder>" })
  })

  it("synthesizes an id for a message the hooks inserted", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    v1.push({ info: { role: "user", sessionID: "ses_1" }, parts: [{ type: "text", text: "repaired" }] })

    const roundTripped = fromV1RequestMessages(v1, origins)
    const inserted = roundTripped[2] as Record<string, unknown>
    expect(inserted.id).toBe("msg_synth_2")
    expect(inserted.role).toBe("user")
    expect(inserted.content).toEqual([{ type: "text", text: "repaired" }])
  })

  it("drops a tool_result without an id instead of emitting an invalid part", () => {
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_MESSAGES, "ses_1", origins)
    v1[0]!.parts.push({ type: "tool_result", content: [] })
    const content = (fromV1RequestMessages(v1, origins)[0] as Record<string, unknown>).content as unknown[]
    expect(content).toHaveLength(1)
  })

  it("tolerates a non-array input", () => {
    const origins = createRequestMessageOrigins()
    expect(fromV1RequestMessages(null, origins)).toEqual([])
  })

  it("marks a tool call finished when its result arrives in a later message", () => {
    // given a V2 request whose tool result lives in its own message
    const origins = createRequestMessageOrigins()

    // when
    const v1 = toV1RequestMessages(V2_SPLIT_TOOL_MESSAGES, "ses_1", origins)

    // then the V1 view reports the call as terminal instead of still running
    const call = v1[0].parts.find((part) => part.type === "tool") as { state?: { status?: string } } | undefined
    expect(call?.state?.status).toBe("completed")
  })

  it("leaves tool-pair-validator with nothing to repair, so no tool_result is injected", async () => {
    // given the same request, run through the hook that used to corrupt it
    const origins = createRequestMessageOrigins()
    const v1 = toV1RequestMessages(V2_SPLIT_TOOL_MESSAGES, "ses_1", origins)
    const hook = createToolPairValidatorHook()
    const transform = hook["experimental.chat.messages.transform"]
    if (!transform) throw new Error("missing tool pair validator transform")

    // when
    await transform({}, { messages: v1 as never })

    // then the only result is the genuine one: no placeholder was pushed into any message (that is
    // what made the provider reject the next request with "user messages only support text and
    // media content")
    const results = v1.flatMap((message) => message.parts).filter((part) => part.type === "tool_result")
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0])).toContain("1 match")
    expect(JSON.stringify(v1)).not.toContain("Tool output unavailable")
    expect(v1[1].parts.map((part) => part.type)).toEqual(["tool_result"])
  })

  it("still reports a genuinely unresolved tool call as running", () => {
    // given an assistant tool call with no result anywhere in the request
    const origins = createRequestMessageOrigins()
    const messages = [V2_SPLIT_TOOL_MESSAGES[0]]

    // when
    const v1 = toV1RequestMessages(messages, "ses_1", origins)

    // then the repair hook still has a reason to act
    const call = v1[0].parts.find((part) => part.type === "tool") as { state?: { status?: string } } | undefined
    expect(call?.state?.status).toBe("running")
  })
})

describe("v1ContentFromV2Result", () => {
  it("normalizes every ToolResultValue kind", () => {
    expect(v1ContentFromV2Result({ type: "content", value: [{ type: "text", text: "a" }] })).toEqual([{ type: "text", text: "a" }])
    expect(v1ContentFromV2Result({ type: "text", value: "b" })).toEqual([{ type: "text", text: "b" }])
    expect(v1ContentFromV2Result({ type: "error", value: "boom" })).toEqual([{ type: "text", text: "boom" }])
    expect(v1ContentFromV2Result({ type: "json", value: { a: 1 } })).toEqual([{ type: "text", text: '{"a":1}' }])
    expect(v1ContentFromV2Result(null)).toEqual([])
  })
})
