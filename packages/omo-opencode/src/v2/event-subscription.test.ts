// packages/omo-opencode/src/v2/event-subscription.test.ts
import { describe, expect, it } from "bun:test"
import { startV2EventSubscription } from "./event-subscription"
import type { V1EventInput } from "./hook-mapping"

const IDLE = { type: "session.idle", data: { sessionID: "ses_1" } }
const UNMAPPED = { type: "server.connected", data: {} }
const IDLE_TWO = { type: "session.idle", data: { sessionID: "ses_2" } }
const CREATED = {
  type: "session.created",
  data: { sessionID: "ses_2", title: "t" },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Async iterable that yields the given events, then parks until its signal aborts. */
async function* cooperative(events: unknown[], signal: AbortSignal): AsyncGenerator<unknown> {
  for (const event of events) yield event
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

describe("startV2EventSubscription", () => {
  it("dispatches only mapped events, in stream order, and passes an abort signal", async () => {
    const dispatched: V1EventInput[] = []
    let receivedSignal: AbortSignal | undefined

    const subscription = startV2EventSubscription({
      subscribe: (options) => {
        receivedSignal = options?.signal
        return cooperative([IDLE, UNMAPPED, CREATED], options?.signal as AbortSignal)
      },
      dispatch: (input) => {
        dispatched.push(input)
      },
    })

    await sleep(10)
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    // `ses_1` was never announced, so its first activity is preceded by the synthesized creation;
    // the unmapped event announces nothing, and the real `session.created` for `ses_2` is not
    // duplicated.
    expect(dispatched.map((input) => input.event.type)).toEqual([
      "session.created",
      "session.idle",
      "session.created",
    ])
    expect(dispatched[0]?.event.properties).toEqual({ info: { id: "ses_1" } })
    expect(dispatched[2]?.event.properties).toEqual({ info: { id: "ses_2", title: "t" } })

    await subscription.dispose()
  })

  it("announces a session the host created before this subscription existed", async () => {
    const dispatched: V1EventInput[] = []

    const subscription = startV2EventSubscription({
      subscribe: (options) =>
        cooperative(
          [
            {
              type: "session.step.started",
              created: 1_000,
              data: {
                sessionID: "ses_late",
                assistantMessageID: "msg_1",
                agent: "sisyphus",
                model: { id: "deepseek-v4-pro", providerID: "deepseek" },
                started: 900,
              },
            },
            { type: "session.idle", data: { sessionID: "ses_late" } },
          ],
          options?.signal as AbortSignal,
        ),
      dispatch: (input) => {
        dispatched.push(input)
      },
    })

    await sleep(10)
    expect(dispatched.map((input) => input.event.type)).toEqual([
      "session.created",
      "message.updated",
      "session.idle",
    ])
    expect(dispatched[0]?.event.properties).toEqual({ info: { id: "ses_late" } })
    expect(dispatched[1]?.event.properties).toMatchObject({ info: { sessionID: "ses_late" } })

    await subscription.dispose()
  })

  it("announces each session once, even when its real creation is on the wire", async () => {
    const dispatched: V1EventInput[] = []

    const subscription = startV2EventSubscription({
      subscribe: (options) =>
        cooperative(
          [
            { type: "session.created", data: { sessionID: "ses_a" } },
            {
              type: "session.step.started",
              created: 1_000,
              data: { sessionID: "ses_a", assistantMessageID: "msg_1" },
            },
            {
              type: "session.step.ended",
              created: 2_000,
              data: { sessionID: "ses_a", assistantMessageID: "msg_1", finish: "stop" },
            },
            { type: "session.idle", data: { sessionID: "ses_b" } },
          ],
          options?.signal as AbortSignal,
        ),
      dispatch: (input) => {
        dispatched.push(input)
      },
    })

    await sleep(10)
    expect(dispatched.map((input) => input.event.type)).toEqual([
      "session.created",
      "message.updated",
      "message.updated",
      "session.created",
      "session.idle",
    ])
    expect(dispatched.filter((input) => input.event.type === "session.created")).toEqual([
      { event: { type: "session.created", properties: { info: { id: "ses_a" } } } },
      { event: { type: "session.created", properties: { info: { id: "ses_b" } } } },
    ])

    await subscription.dispose()
  })

  it("correlates session.step.started with the session.step.ended across iterations", async () => {
    const dispatched: V1EventInput[] = []

    const subscription = startV2EventSubscription({
      subscribe: (options) =>
        cooperative(
          [
            {
              type: "session.step.started",
              created: 1_000,
              data: {
                sessionID: "ses_1",
                assistantMessageID: "msg_1",
                agent: "sisyphus",
                model: { id: "deepseek-v4-pro", providerID: "deepseek" },
                started: 900,
              },
            },
            IDLE,
            {
              type: "session.step.ended",
              created: 2_000,
              data: {
                sessionID: "ses_1",
                assistantMessageID: "msg_1",
                finish: "stop",
                tokens: { input: 1, output: 2 },
              },
            },
          ],
          options?.signal as AbortSignal,
        ),
      dispatch: (input) => {
        dispatched.push(input)
      },
    })

    await sleep(10)
    expect(dispatched.map((input) => input.event.type)).toEqual([
      "session.created",
      "message.updated",
      "session.idle",
      "message.updated",
    ])
    const messages = dispatched.filter((input) => input.event.type === "message.updated")
    const startedInfo = messages[0]?.event.properties.info as Record<string, unknown>
    expect(startedInfo).toMatchObject({ id: "msg_1", role: "assistant", providerID: "deepseek" })
    expect(startedInfo.finish).toBeUndefined()
    // The identity the start event announced survives the intervening idle event.
    const endedInfo = messages[1]?.event.properties.info as Record<string, unknown>
    expect(endedInfo).toMatchObject({
      id: "msg_1",
      role: "assistant",
      finish: "stop",
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      agent: "sisyphus",
    })
    expect(endedInfo.time).toEqual({ created: 900, completed: 2_000 })

    await subscription.dispose()
  })

  it("isolates a dispatch failure and keeps consuming", async () => {
    const dispatched: string[] = []
    const failures: Array<{ error: unknown; type: string }> = []
    let calls = 0

    const subscription = startV2EventSubscription({
      subscribe: (options) =>
        cooperative([CREATED, IDLE_TWO, IDLE_TWO], options?.signal as AbortSignal),
      dispatch: (input) => {
        calls += 1
        if (calls === 2) throw new Error("dispatch boom")
        dispatched.push(input.event.type)
      },
      onDispatchError: (error, input) => {
        failures.push({ error, type: input.event.type })
      },
    })

    await sleep(10)
    // The second event threw but the loop continued to the third.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.type).toBe("session.idle")
    expect(dispatched).toEqual(["session.created", "session.idle"])

    await subscription.dispose()
  })

  it("catches a synchronous subscribe failure without rejecting", async () => {
    const streamErrors: unknown[] = []
    const subscription = startV2EventSubscription({
      subscribe: () => {
        throw new Error("stream boom")
      },
      dispatch: () => {},
      onStreamError: (error) => {
        streamErrors.push(error)
      },
    })

    await subscription.settled
    expect(streamErrors).toHaveLength(1)
    await subscription.dispose()
  })

  it("stops consuming and aborts the stream on dispose", async () => {
    let aborted = false
    const dispatched: string[] = []

    const subscription = startV2EventSubscription({
      subscribe: (options) => {
        const signal = options?.signal as AbortSignal
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return cooperative([IDLE], signal)
      },
      dispatch: (input) => {
        dispatched.push(input.event.type)
      },
    })

    await sleep(10)
    expect(dispatched).toEqual(["session.created", "session.idle"])

    await subscription.dispose()
    expect(aborted).toBe(true)
    await subscription.dispose()
    expect(aborted).toBe(true)
  })

  it("resolves dispose within the timeout even when the stream ignores the abort", async () => {
    async function* stubborn(): AsyncGenerator<unknown> {
      yield IDLE
      await new Promise<void>(() => {
        // Deliberately never resolves and never observes the abort signal.
      })
    }

    const subscription = startV2EventSubscription({
      subscribe: () => stubborn(),
      dispatch: () => {},
      disposeTimeoutMs: 20,
    })

    await sleep(5)
    const started = Date.now()
    await subscription.dispose()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
