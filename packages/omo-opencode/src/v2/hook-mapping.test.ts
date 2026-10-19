// packages/omo-opencode/src/v2/hook-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { V2_EVENT_TO_V1, createV1EventMapper, isMappedV2Event, toV1Event } from "./hook-mapping"

// Captured verbatim from `GET /api/event` on opencode v2.0.11.
const CAPTURED_SESSION_CREATED = {
  id: "evt_0ccc1d298001Uc3NPHyFnxgSV5",
  created: 1790141649560,
  type: "session.created",
  location: { directory: "/home/user/omo-v2/.omo/probe5" },
  data: {
    sessionID: "ses_f333e2d92ffecADTnfjxs5x0aZ",
    slug: "playful-rocket",
    version: "2.0.11",
    projectID: "7cbcacac0ade4b5da1b1cef75629990dcd0f1eaf",
    subpath: ".omo/probe5",
    title: "evt",
  },
  durable: { aggregateID: "ses_f333e2d92ffecADTnfjxs5x0aZ", seq: 0, version: 1 },
}

describe("toV1Event", () => {
  it("maps the captured session.created envelope to the V1 {event:{type,properties}} shape", () => {
    expect(toV1Event(CAPTURED_SESSION_CREATED)).toEqual({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_f333e2d92ffecADTnfjxs5x0aZ", title: "evt" } },
      },
    })
  })

  it("maps session.idle and session.compacted to their V1 names", () => {
    expect(toV1Event({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    expect(toV1Event({ type: "session.compacted", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.compacted", properties: { sessionID: "ses_1" } },
    })
  })

  it("maps the real V2 turn-end envelope onto V1 session.idle", () => {
    // V2 never emits `session.idle`; the live catalog capture shows `session.execution.succeeded`
    // is what ends a turn, so the V1 idle hooks depend on this mapping.
    expect(toV1Event({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    expect(toV1Event({ type: "session.execution.succeeded", data: {} })).toBeUndefined()
  })

  it("maps the real V2 compaction end event onto V1 session.compacted", () => {
    expect(toV1Event({ type: "session.compaction.ended", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.compacted", properties: { sessionID: "ses_1" } },
    })
  })

  it("maps both V2 failure events onto V1 session.error with the error payload", () => {
    const error = { name: "ProviderError", message: "boom" }
    for (const type of ["session.execution.failed", "session.step.failed"]) {
      expect(toV1Event({ type, data: { sessionID: "ses_1", error } })).toEqual({
        event: { type: "session.error", properties: { sessionID: "ses_1", error } },
      })
    }
  })

  it("synthesizes a retry status from session.retry.scheduled", () => {
    expect(
      toV1Event({ type: "session.retry.scheduled", data: { sessionID: "ses_1", attempt: 2, next: 5000 } }),
    ).toEqual({
      event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2, next: 5000 } } },
    })
  })

  it("passes through V1-native events that exist unchanged in V2", () => {
    expect(toV1Event({ type: "file.edited", data: { file: "/tmp/a.ts" } })).toEqual({
      event: { type: "file.edited", properties: { file: "/tmp/a.ts" } },
    })
    expect(toV1Event({ type: "permission.replied", data: { sessionID: "ses_1", id: "per_1" } })).toEqual({
      event: { type: "permission.replied", properties: { sessionID: "ses_1", id: "per_1" } },
    })
  })

  it("drops unmapped events", () => {
    expect(toV1Event({ type: "server.connected", data: {} })).toBeUndefined()
    expect(toV1Event({ type: "session.usage.updated", data: { sessionID: "ses_1" } })).toBeUndefined()
    expect(isMappedV2Event({ type: "server.connected" })).toBe(false)
    expect(isMappedV2Event({ type: "session.idle" })).toBe(true)
  })

  it("drops malformed input instead of throwing", () => {
    expect(toV1Event(null)).toBeUndefined()
    expect(toV1Event("session.idle")).toBeUndefined()
    expect(toV1Event({})).toBeUndefined()
    // A mapped type with no usable session id cannot be dispatched.
    expect(toV1Event({ type: "session.idle", data: {} })).toBeUndefined()
    expect(toV1Event({ type: "session.created", data: { sessionID: "" } })).toBeUndefined()
  })

  it("rebuilds a streaming text part as message.part.updated and message.part.delta", () => {
    // V2 has no part objects: the text stream arrives as its own trio of events.
    expect(
      toV1Event({ type: "session.text.started", created: 1_000, data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 } }),
    ).toEqual({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          part: { id: "msg_1:text:0", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "" },
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
        },
      },
    })
    expect(
      toV1Event({
        type: "session.text.delta",
        created: 1_001,
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "hi" },
      }),
    ).toEqual({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "msg_1:text:0",
          field: "text",
          delta: "hi",
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
        },
      },
    })
    // The end event carries the assembled text, and shares the id the delta addressed.
    const ended = toV1Event({
      type: "session.text.ended",
      created: 1_002,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "hi there" },
    })
    expect(ended?.event.properties.part).toMatchObject({ id: "msg_1:text:0", type: "text", text: "hi there" })
  })

  it("keeps the reasoning stream out of the text field", () => {
    // Handlers count `field: "text"` deltas as assistant output, so reasoning must not claim it.
    const delta = toV1Event({
      type: "session.reasoning.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 2, delta: "thinking" },
    })
    expect(delta?.event.properties).toMatchObject({ field: "reasoning", partID: "msg_1:reasoning:2" })
    const started = toV1Event({
      type: "session.reasoning.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 2 },
    })
    expect(started?.event.properties.part).toMatchObject({ type: "reasoning", id: "msg_1:reasoning:2" })
  })

  it("rebuilds a tool call as a V1 tool part with a V1 status", () => {
    const called = toV1Event({
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash", input: { command: "ls" } },
    })
    expect(called?.event.properties.part).toEqual({
      id: "call_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "ls" } },
    })
    const succeeded = toV1Event({
      type: "session.tool.success",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "bash",
        content: [{ type: "text", text: "ok" }],
      },
    })
    expect(succeeded?.event.properties.part).toMatchObject({
      type: "tool",
      state: { status: "completed", output: [{ type: "text", text: "ok" }] },
    })
    const failed = toV1Event({
      type: "session.tool.failed",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", error: { message: "nope" } },
    })
    expect(failed?.event.properties.part).toMatchObject({ state: { status: "error", error: { message: "nope" } } })
    // Streamed tool input is a delta, addressed to the same tool part id.
    const inputDelta = toV1Event({
      type: "session.tool.input.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", delta: '{"com' },
    })
    expect(inputDelta?.event.properties).toMatchObject({ partID: "call_1", field: "input", delta: '{"com' })
  })

  it("passes the assembled message content through as a part", () => {
    const converted = toV1Event({
      type: "session.message.content.updated",
      data: {
        sessionID: "ses_1",
        messageID: "msg_1",
        content: { type: "text", text: "hello", state: "completed", time: { created: 1, completed: 2 } },
      },
    })
    expect(converted?.event.properties.part).toEqual({
      type: "text",
      text: "hello",
      state: "completed",
      time: { created: 1, completed: 2 },
      id: "msg_1:text:0",
      messageID: "msg_1",
      sessionID: "ses_1",
    })
  })

  it("maps the V2 interrupt onto the V1 session.stop", () => {
    expect(toV1Event({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } })).toEqual({
      event: { type: "session.stop", properties: { sessionID: "ses_1" } },
    })
  })

  it("drops a part event that cannot address a message or session", () => {
    expect(toV1Event({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "hi" } })).toBeUndefined()
    expect(toV1Event({ type: "session.text.delta", data: { assistantMessageID: "msg_1", delta: "hi" } })).toBeUndefined()
    expect(toV1Event({ type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })).toBeUndefined()
    expect(toV1Event({ type: "session.tool.success", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })).toBeUndefined()
  })

  it("keeps the rename table self-consistent", () => {
    for (const [v2, v1] of Object.entries(V2_EVENT_TO_V1)) {
      expect(typeof v2).toBe("string")
      expect(v1.startsWith("session.") || v1.includes(".")).toBe(true)
    }
  })
})

// Payload shapes from `@opencode/schema@2.0.30` (`session-event.d.ts`), matching the live catalog
// captured in `.omo/tmp/event-catalog-2030/`: the step start announces provider/model/agent, the
// step end carries finish/tokens/cost and no identity at all.
const STEP_STARTED = {
  id: "evt_step_started",
  created: 1792139118033,
  type: "session.step.started",
  data: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    agent: "sisyphus",
    model: { id: "deepseek-v4-pro", providerID: "deepseek", variant: "high" },
    started: 1792139118000,
  },
}

const STEP_ENDED = {
  id: "evt_step_ended",
  created: 1792139120282,
  type: "session.step.ended",
  data: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    finish: "stop",
    rawFinish: "stop",
    cost: 0.01,
    tokens: { input: 100, output: 7, reasoning: 3, cache: { read: 10, write: 2 } },
  },
}

function infoOf(input: ReturnType<typeof toV1Event>): Record<string, unknown> {
  return (input?.event.properties.info ?? {}) as Record<string, unknown>
}

function startedFor(assistantMessageID: string, providerID = "deepseek", modelID = "deepseek-v4-pro") {
  return {
    ...STEP_STARTED,
    data: { ...STEP_STARTED.data, assistantMessageID, model: { id: modelID, providerID } },
  }
}

function endedFor(assistantMessageID: string) {
  return { ...STEP_ENDED, data: { ...STEP_ENDED.data, assistantMessageID } }
}

describe("message.updated synthesis", () => {
  it("maps session.step.started and session.step.ended to message.updated", () => {
    expect(isMappedV2Event({ type: "session.step.started" })).toBe(true)
    expect(isMappedV2Event({ type: "session.step.ended" })).toBe(true)
  })

  it("emits the assistant message with its identity when the step starts, and no finish", () => {
    expect(toV1Event(STEP_STARTED)).toEqual({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            providerID: "deepseek",
            modelID: "deepseek-v4-pro",
            agent: "sisyphus",
            time: { created: 1792139118000 },
          },
        },
      },
    })
  })

  it("carries the start identity into the message.updated the step end produces", () => {
    const mapper = createV1EventMapper()
    mapper.toV1Event(STEP_STARTED)
    const info = infoOf(mapper.toV1Event(STEP_ENDED))
    expect(info).toEqual({
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      agent: "sisyphus",
      finish: "stop",
      tokens: { input: 100, output: 7, reasoning: 3, cache: { read: 10, write: 2 } },
      cost: 0.01,
      time: { created: 1792139118000, completed: 1792139120282 },
    })
  })

  it("cannot correlate without the mapper, which is why the subscription keeps state", () => {
    const info = infoOf(toV1Event(STEP_ENDED))
    expect(info).toMatchObject({ id: "msg_1", role: "assistant", finish: "stop" })
    expect(info.providerID).toBeUndefined()
    expect(info.time).toEqual({ created: 1792139120282, completed: 1792139120282 })
  })

  it("still emits a finished message when the start event never arrived", () => {
    const mapper = createV1EventMapper()
    const info = infoOf(mapper.toV1Event(STEP_ENDED))
    expect(info).toMatchObject({ id: "msg_1", finish: "stop", cost: 0.01 })
    expect(info.providerID).toBeUndefined()
  })

  it("does not attach one step's identity to another step", () => {
    const mapper = createV1EventMapper()
    mapper.toV1Event(STEP_STARTED)
    mapper.toV1Event(startedFor("msg_2", "zai", "glm-5.3"))
    const info = infoOf(mapper.toV1Event(endedFor("msg_2")))
    expect(info).toMatchObject({ id: "msg_2", providerID: "zai", modelID: "glm-5.3", finish: "stop" })
  })

  it("forgets the oldest pending step past the cap, never the newest", () => {
    const mapper = createV1EventMapper({ maxPendingSteps: 2 })
    for (const id of ["msg_1", "msg_2", "msg_3"]) mapper.toV1Event(startedFor(id))
    expect(infoOf(mapper.toV1Event(endedFor("msg_1"))).providerID).toBeUndefined()
    expect(infoOf(mapper.toV1Event(endedFor("msg_3"))).providerID).toBe("deepseek")
  })

  it("uses the injected clock when the envelope carries no created timestamp", () => {
    const mapper = createV1EventMapper({ now: () => 42 })
    const info = infoOf(
      mapper.toV1Event({
        type: "session.step.ended",
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop" },
      }),
    )
    expect(info.time).toEqual({ created: 42, completed: 42 })
  })

  it("drops a step event with no assistant message id or no session id", () => {
    const mapper = createV1EventMapper()
    expect(mapper.toV1Event({ type: "session.step.ended", data: { sessionID: "ses_1", finish: "stop" } })).toBeUndefined()
    expect(mapper.toV1Event({ type: "session.step.ended", data: { assistantMessageID: "msg_1", finish: "stop" } })).toBeUndefined()
    expect(mapper.toV1Event({ type: "session.step.started", data: { assistantMessageID: "msg_1" } })).toBeUndefined()
  })
})
