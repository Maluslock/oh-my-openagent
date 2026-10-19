// packages/omo-opencode/src/v2/hook-mapping.ts
import { isRecord } from "../shared"

/**
 * V2 → V1 event-shape adapters.
 *
 * V2 emits a flat event envelope (`{id, created, type, location, data, durable?}`) while V1's
 * `event` hook receives `{event: {type, properties}}`. omo's event handlers key off V1 event
 * names and read `event.properties` (`sessionID`, `info`, `status`, `error`), so this module
 * rebuilds that pair.
 *
 * Only the lifecycle subset omo actually consumes is mapped; anything else returns `undefined`
 * and is dropped rather than mis-dispatched. The V2 vocabulary is ~130 types (see
 * `docs/superpowers/notes/2026-09-23-v2-hook-injection-findings.md`).
 *
 * Two mappings are a synthesis, not a rename: V2 has no `message.updated` (rebuilt from
 * `session.step.started` + `session.step.ended` by `createV1EventMapper`) and no message parts
 * (rebuilt from `session.text.*`, `session.reasoning.*`, `session.tool.*` and
 * `session.message.content.updated`). Between them they keep the `message.updated`- and
 * `message.part.*`-keyed hooks - preemptive compaction, runtime fallback, the todo enforcer,
 * notifications, activity tracking - alive on V2.
 *
 * Verified against a live `GET /api/event` capture on opencode v2.0.11 for `session.created`, and
 * against a full-catalog live capture for the turn envelope (`live-v2-event-catalog.md`: one prompt
 * emits `session.execution.started` -> `session.execution.succeeded` and never `session.idle`);
 * the remaining mappings are derived from `@opencode/schema@2.0.11` event definitions and are
 * pinned by unit tests until a live retry/error event can be captured.
 */

export type V1EventInput = {
  event: { type: string; properties: Record<string, unknown> }
}

/** V2 event type → V1 event type for every mapped event. */
export const V2_EVENT_TO_V1: Readonly<Record<string, string>> = Object.freeze({
  "session.created": "session.created",
  "session.deleted": "session.deleted",
  // V2 has no `session.idle` (and no `session.status`): a live capture of the whole event catalog
  // for one prompt shows the turn envelope is `session.execution.started` ->
  // `session.execution.succeeded`, with no idle event at all. See
  // `live-v2-event-catalog.md`. Without this mapping every V1 idle-keyed omo hook is dead on V2,
  // which is why team member status never left `running` and live delivery never fired.
  "session.execution.succeeded": "session.idle",
  "session.compaction.ended": "session.compacted",
  // Kept for hosts that do emit them; harmless when absent.
  "session.idle": "session.idle",
  "session.status": "session.status",
  "session.execution.failed": "session.error",
  "session.step.failed": "session.error",
  "session.compacted": "session.compacted",
  "session.retry.scheduled": "session.status",
  "file.edited": "file.edited",
  "permission.asked": "permission.asked",
  "permission.replied": "permission.replied",
  // `message.updated` is not a V2 event (it exists only in the V1 namespace of `@opencode/schema`).
  // V2 reports one assistant step as `session.step.started` (provider, model, agent, dispatch time)
  // and `session.step.ended` (finish, tokens, cost); omo's V1 handlers read
  // `message.updated.info.{id,sessionID,role,finish,tokens,providerID,modelID,agent}`, so both are
  // mapped and merged into the V1 message view. Preemptive compaction, runtime fallback, the todo
  // continuation enforcer, notifications and the anthropic recovery hook are all dead on V2 without
  // this — their `tokenCache`/state is only ever filled from `message.updated`.
  "session.step.started": "message.updated",
  "session.step.ended": "message.updated",
  // V2 has no message part objects either. It reports each stream as its own event family
  // (`session.text.*`, `session.reasoning.*`, `session.tool.*`) and the assembled message as
  // `session.message.content.updated`, while every activity-keyed V1 hook listens to
  // `message.part.updated` / `message.part.delta` (the first-prompt watchdog, the ralph loop, the
  // notification scheduler, the todo continuation enforcer, compaction context injection, atlas and
  // the background-notification forwarder). The part is rebuilt below with a deterministic id.
  "session.text.started": "message.part.updated",
  "session.text.delta": "message.part.delta",
  "session.text.ended": "message.part.updated",
  "session.reasoning.started": "message.part.updated",
  "session.reasoning.delta": "message.part.delta",
  "session.reasoning.ended": "message.part.updated",
  "session.tool.input.started": "message.part.updated",
  "session.tool.input.delta": "message.part.delta",
  "session.tool.input.ended": "message.part.updated",
  "session.tool.called": "message.part.updated",
  "session.tool.progress": "message.part.updated",
  "session.tool.success": "message.part.updated",
  "session.tool.failed": "message.part.updated",
  "session.message.content.updated": "message.part.updated",
  // V2 spells the user interrupt `session.execution.interrupted`; V1 handlers keyed on
  // `session.stop` (runtime fallback, the watchdog, the unstable-agent babysitter) never saw it.
  "session.execution.interrupted": "session.stop",
})

/**
 * Identity captured when a step starts, merged into the `message.updated` its end produces.
 * `session.step.ended` carries finish/tokens/cost but no provider or model, so the two halves of a
 * step have to be correlated by `assistantMessageID`.
 */
type LinkedStep = {
  readonly providerID?: string
  readonly modelID?: string
  readonly agent?: string
  readonly created?: number
}

/** How many unfinished steps the mapper remembers before dropping the oldest. */
const DEFAULT_MAX_PENDING_STEPS = 64

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function assistantMessageIDOf(data: Record<string, unknown>): string | undefined {
  const value = data.assistantMessageID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The provider/model/agent a `session.step.started` payload announces. */
function linkedStepOf(data: Record<string, unknown>): LinkedStep {
  const model = isRecord(data.model) ? data.model : undefined
  const providerID = stringField(model, "providerID")
  const modelID = stringField(model, "id")
  const agent = stringField(data, "agent")
  const started = numberField(data, "started")
  return {
    ...(providerID !== undefined ? { providerID } : {}),
    ...(modelID !== undefined ? { modelID } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(started !== undefined ? { created: started } : {}),
  }
}

function identityFields(linked: LinkedStep | undefined): Record<string, unknown> {
  if (linked === undefined) return {}
  return {
    ...(linked.providerID !== undefined ? { providerID: linked.providerID } : {}),
    ...(linked.modelID !== undefined ? { modelID: linked.modelID } : {}),
    ...(linked.agent !== undefined ? { agent: linked.agent } : {}),
  }
}

/**
 * V1 part ids belong to the host, but a V2 stream event carries none: only the assistant message id
 * and an ordinal. Deriving the id keeps a start/delta/end sequence addressing one V1 part.
 */
function partIDFor(kind: string, messageID: string, ordinal: unknown): string {
  return `${messageID}:${kind}:${typeof ordinal === "number" ? ordinal : 0}`
}

/** The `{id, sessionID, role}` every activity-keyed part handler resolves a session from. */
function assistantInfo(messageID: string, sessionID: string): Record<string, unknown> {
  return { id: messageID, sessionID, role: "assistant" }
}

/** V1 tool parts carry `state.status`; V2 reports each phase of a tool call as its own event. */
function toolStateOf(v2Type: string, data: Record<string, unknown>): Record<string, unknown> {
  const status =
    v2Type === "session.tool.success" ? "completed" : v2Type === "session.tool.failed" ? "error" : "running"
  const input = data.input ?? (typeof data.text === "string" ? data.text : undefined)
  return {
    status,
    ...(input !== undefined ? { input } : {}),
    ...(data.content !== undefined ? { output: data.content } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
    ...(data.executed !== undefined ? { executed: data.executed } : {}),
    ...(data.resultState !== undefined ? { resultState: data.resultState } : {}),
  }
}

function sessionIDOf(data: Record<string, unknown>): string | undefined {
  const value = data.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

type BuildContext = {
  /** Identity captured from the matching `session.step.started`; only `session.step.ended` uses it. */
  readonly linked?: LinkedStep
  /** The envelope's own `created` timestamp, used when the payload carries no time. */
  readonly eventCreated: number
}

function buildProperties(
  v2Type: string,
  data: Record<string, unknown>,
  context: BuildContext,
): Record<string, unknown> | undefined {
  const sessionID = sessionIDOf(data)

  switch (v2Type) {
    case "session.created":
      if (sessionID === undefined) return undefined
      return {
        info: {
          id: sessionID,
          ...(typeof data.title === "string" ? { title: data.title } : {}),
          ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
        },
      }
    case "session.deleted":
      if (sessionID === undefined) return undefined
      return { info: { id: sessionID } }
    case "session.idle":
    case "session.compacted":
    case "session.execution.succeeded":
    case "session.compaction.ended":
      if (sessionID === undefined) return undefined
      return { sessionID }
    case "session.status":
      if (sessionID === undefined) return undefined
      // V2 `data` carries the status payload; keep the whole record when no explicit field exists.
      return { sessionID, status: data.status ?? data }
    case "session.execution.failed":
    case "session.step.failed":
      if (sessionID === undefined) return undefined
      return { sessionID, error: data.error ?? data }
    case "session.retry.scheduled":
      if (sessionID === undefined) return undefined
      return {
        sessionID,
        status: {
          type: "retry",
          ...(typeof data.attempt === "number" ? { attempt: data.attempt } : {}),
          ...(typeof data.next === "number" ? { next: data.next } : {}),
          ...(typeof data.message === "string" ? { message: data.message } : {}),
        },
      }
    // A step starts as the V1 assistant message appears: identity (provider/model/agent) and the
    // dispatch time, and deliberately no `finish` — V1 emitted `message.updated` for a message the
    // moment it existed, long before the model finished, and handlers tolerate that partial view.
    case "session.step.started": {
      const id = assistantMessageIDOf(data)
      if (id === undefined || sessionID === undefined) return undefined
      const linked = linkedStepOf(data)
      return {
        info: {
          id,
          sessionID,
          role: "assistant",
          ...identityFields(linked),
          time: { created: linked.created ?? numberField(data, "started") ?? context.eventCreated },
        },
      }
    }
    // A step ends as the V1 assistant message completes: same identity plus the fields the V1
    // handlers gate on (`finish`, `tokens`, `cost`).
    case "session.step.ended": {
      const id = assistantMessageIDOf(data)
      if (id === undefined || sessionID === undefined) return undefined
      const linked = context.linked
      return {
        info: {
          id,
          sessionID,
          role: "assistant",
          ...identityFields(linked),
          ...(data.finish !== undefined ? { finish: data.finish } : {}),
          ...(isRecord(data.tokens) ? { tokens: data.tokens } : {}),
          ...(data.cost !== undefined ? { cost: data.cost } : {}),
          time: {
            created: linked?.created ?? context.eventCreated,
            completed: numberField(data, "ended") ?? context.eventCreated,
          },
        },
      }
    }
    // A part stream (text or reasoning) starts and ends as `message.part.updated`; the chunk in
    // between is `message.part.delta` with the V1 `field`/`delta` pair the handlers read.
    case "session.text.started":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.ended": {
      const messageID = assistantMessageIDOf(data)
      if (messageID === undefined || sessionID === undefined) return undefined
      const kind = v2Type.startsWith("session.reasoning") ? "reasoning" : "text"
      return {
        sessionID,
        messageID,
        part: {
          id: partIDFor(kind, messageID, data.ordinal),
          messageID,
          sessionID,
          type: kind,
          text: typeof data.text === "string" ? data.text : "",
        },
        info: assistantInfo(messageID, sessionID),
      }
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const messageID = assistantMessageIDOf(data)
      const delta = typeof data.delta === "string" ? data.delta : undefined
      if (messageID === undefined || sessionID === undefined || delta === undefined) return undefined
      const kind = v2Type.startsWith("session.reasoning") ? "reasoning" : "text"
      return {
        sessionID,
        messageID,
        partID: partIDFor(kind, messageID, data.ordinal),
        field: kind,
        delta,
        info: assistantInfo(messageID, sessionID),
      }
    }
    case "session.tool.input.delta": {
      const messageID = assistantMessageIDOf(data)
      const partID = stringField(data, "id")
      const delta = typeof data.delta === "string" ? data.delta : undefined
      if (messageID === undefined || sessionID === undefined || partID === undefined || delta === undefined) {
        return undefined
      }
      return {
        sessionID,
        messageID,
        partID,
        field: "input",
        delta,
        info: assistantInfo(messageID, sessionID),
      }
    }
    case "session.tool.input.started":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const messageID = assistantMessageIDOf(data)
      const partID = stringField(data, "id")
      if (messageID === undefined || sessionID === undefined || partID === undefined) return undefined
      const tool = stringField(data, "name")
      return {
        sessionID,
        messageID,
        part: {
          id: partID,
          messageID,
          sessionID,
          type: "tool",
          ...(tool !== undefined ? { tool } : {}),
          state: toolStateOf(v2Type, data),
        },
        info: assistantInfo(messageID, sessionID),
      }
    }
    // The assembled message: V2 already hands over a part-shaped `content` (type, text, state, time).
    case "session.message.content.updated": {
      const messageID = stringField(data, "messageID")
      const content = isRecord(data.content) ? data.content : undefined
      if (messageID === undefined || sessionID === undefined || content === undefined) return undefined
      const type = stringField(content, "type") ?? "content"
      return {
        sessionID,
        messageID,
        part: {
          ...content,
          id: stringField(content, "id") ?? partIDFor(type, messageID, undefined),
          messageID,
          sessionID,
        },
        info: assistantInfo(messageID, sessionID),
      }
    }
    case "session.execution.interrupted":
      if (sessionID === undefined) return undefined
      return { sessionID }
    default:
      return Object.keys(data).length > 0 ? data : {}
  }
}

function convert(event: unknown, linked: LinkedStep | undefined, now: () => number): V1EventInput | undefined {
  if (!isRecord(event)) return undefined
  const v2Type = event.type
  if (typeof v2Type !== "string") return undefined
  const v1Type = V2_EVENT_TO_V1[v2Type]
  if (v1Type === undefined) return undefined
  const data = isRecord(event.data) ? event.data : {}
  const eventCreated = numberField(event, "created") ?? now()
  const properties = buildProperties(v2Type, data, {
    ...(linked !== undefined ? { linked } : {}),
    eventCreated,
  })
  if (properties === undefined) return undefined
  return { event: { type: v1Type, properties } }
}

/**
 * Convert one V2 event envelope into the V1 `EventInput` shape, or `undefined` when the event is
 * unmapped (dropped) or malformed.
 *
 * Stateless: a `session.step.ended` converted here has no provider/model/agent, because that
 * identity arrives on the earlier `session.step.started`. Streams must use
 * `createV1EventMapper()` to get the correlated view.
 */
export function toV1Event(event: unknown): V1EventInput | undefined {
  return convert(event, undefined, Date.now)
}

export type V1EventMapperOptions = {
  /** Clock used when an envelope carries no `created`. Default `Date.now`. */
  readonly now?: () => number
  /** Unfinished steps to remember before the oldest is dropped. Default {@link DEFAULT_MAX_PENDING_STEPS}. */
  readonly maxPendingSteps?: number
}

export type V1EventMapper = {
  readonly toV1Event: (event: unknown) => V1EventInput | undefined
}

/**
 * A stateful `toV1Event`: remembers each `session.step.started` by `assistantMessageID` so the
 * `message.updated` synthesized from the matching `session.step.ended` carries the provider, model
 * and agent that only the start event knew. Pending steps are consumed on the end event and capped,
 * so a stream that loses an end event cannot grow the map without bound.
 */
export function createV1EventMapper(options: V1EventMapperOptions = {}): V1EventMapper {
  const pending = new Map<string, LinkedStep>()
  const now = options.now ?? Date.now
  const maxPendingSteps = options.maxPendingSteps ?? DEFAULT_MAX_PENDING_STEPS

  return {
    toV1Event: (event: unknown): V1EventInput | undefined => {
      if (!isRecord(event)) return undefined
      const v2Type = event.type
      if (typeof v2Type !== "string" || V2_EVENT_TO_V1[v2Type] === undefined) return undefined
      const data = isRecord(event.data) ? event.data : {}
      const id = assistantMessageIDOf(data)

      if (v2Type === "session.step.started" && id !== undefined) {
        pending.set(id, linkedStepOf(data))
        while (pending.size > maxPendingSteps) {
          const oldest = pending.keys().next()
          if (oldest.done === true) break
          pending.delete(oldest.value)
        }
        return convert(event, undefined, now)
      }

      if (v2Type === "session.step.ended" && id !== undefined) {
        const linked = pending.get(id)
        pending.delete(id)
        return convert(event, linked, now)
      }

      return convert(event, undefined, now)
    },
  }
}

/** Whether an event type is mapped (used by the subscription loop to skip early). */
export function isMappedV2Event(event: unknown): boolean {
  return isRecord(event) && typeof event.type === "string" && event.type in V2_EVENT_TO_V1
}
