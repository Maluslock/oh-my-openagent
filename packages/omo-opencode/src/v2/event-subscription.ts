// packages/omo-opencode/src/v2/event-subscription.ts
import { log } from "../shared"
import { createV1EventMapper, type V1EventInput } from "./hook-mapping"

/**
 * Drives omo's V1 `event` handler from the V2 event stream.
 *
 * V2 exposes `ctx.event.subscribe(requestOptions?)` as an `AsyncIterable` of flat event
 * envelopes whose `requestOptions.signal` cancels the underlying stream. This runner consumes
 * that iterable, converts each envelope with a per-subscription `createV1EventMapper()`, and
 * dispatches to the assembled V1 handler. It never throws into `setup`: stream failures and
 * per-event dispatch failures are logged (per-event isolation mirrors V1's `createEventHookRunner`).
 *
 * The mapper is stateful on purpose: the synthesized `message.updated` for a finished step has to
 * carry the provider/model/agent that only that step's `session.step.started` announced, so the two
 * events must be correlated across iterations.
 *
 * `session.created` gets the same treatment for a different reason. V1 delivered it when the session
 * was created, so every hook keyed on it (per-session fallback state, session notifications, ast-grep
 * provisioning, the codegraph bootstrap) saw it. V2 only delivers it to a plugin that is already
 * subscribed - and project plugins load lazily, on their first turn. The session that triggers that
 * load is therefore created before anything is listening, which means *every* session of an
 * `opencode run` process, and the first one of a long-lived server, never produces the event. A
 * session is announced the first time the stream shows activity for one whose creation was not seen,
 * which keeps the V1 invariant that `session.created` precedes everything else for a session.
 *
 * `dispose()` aborts the stream and resolves once the loop unwinds. A non-cooperative iterable
 * cannot hold teardown open forever: the wait is bounded and a timeout is logged.
 */

export type V2EventSubscribe = (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>

export type EventSubscription = {
  readonly dispose: () => Promise<void>
  /** Test seam: resolves when the consume loop has unwound. */
  readonly settled: Promise<void>
}

export type EventSubscriptionOptions = {
  readonly subscribe: V2EventSubscribe
  readonly dispatch: (input: V1EventInput) => Promise<void> | void
  readonly onDispatchError?: (error: unknown, input: V1EventInput) => void
  readonly onStreamError?: (error: unknown) => void
  /** Bound on how long `dispose()` waits for the loop to unwind. Default 2000ms. */
  readonly disposeTimeoutMs?: number
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Session id of a raw V2 envelope, for the `session.created` announcement below. */
function sessionIDOfEnvelope(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const data = (event as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return undefined
  const value = (data as { sessionID?: unknown }).sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function startV2EventSubscription(options: EventSubscriptionOptions): EventSubscription {
  const controller = new AbortController()
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  const mapper = createV1EventMapper()
  /** Sessions this stream has accounted for, whether by a real or a synthesized `session.created`. */
  const announced = new Set<string>()
  let disposed = false

  /**
   * The `session.created` a V1 host would already have delivered, or nothing. Recording happens for a
   * real creation too: that is what stops a later activity event from announcing the session twice.
   */
  const takeAnnouncement = (event: unknown, v1Type: string): V1EventInput | undefined => {
    const sessionID = sessionIDOfEnvelope(event)
    if (sessionID === undefined || announced.has(sessionID)) return undefined
    announced.add(sessionID)
    if (v1Type === "session.created") return undefined
    return { event: { type: "session.created", properties: { info: { id: sessionID } } } }
  }

  const deliver = async (input: V1EventInput): Promise<void> => {
    try {
      await options.dispatch(input)
    } catch (error) {
      if (options.onDispatchError !== undefined) {
        options.onDispatchError(error, input)
      } else {
        log("[v2] event dispatch failed", { type: input.event.type, error: describeError(error) })
      }
    }
  }

  const consume = async (): Promise<void> => {
    try {
      for await (const event of options.subscribe({ signal: controller.signal })) {
        const input = mapper.toV1Event(event)
        if (input === undefined) continue
        const announcement = takeAnnouncement(event, input.event.type)
        if (announcement !== undefined) await deliver(announcement)
        await deliver(input)
      }
    } catch (error) {
      // An abort is the expected teardown path, not an error.
      if (controller.signal.aborted) return
      if (options.onStreamError !== undefined) {
        options.onStreamError(error)
      } else {
        log("[v2] event subscription ended with error", { error: describeError(error) })
      }
    }
  }

  const settled = consume()

  return {
    settled,
    dispose: async (): Promise<void> => {
      if (disposed) return
      disposed = true
      controller.abort()

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), disposeTimeoutMs)
      })
      const outcome = await Promise.race([settled.then(() => "settled" as const), timeout])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === "timeout") {
        log("[v2] event subscription did not unwind within the dispose timeout", { disposeTimeoutMs })
      }
    },
  }
}
