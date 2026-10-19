// packages/omo-opencode/src/v2/session-activity.test.ts
import { describe, expect, it } from "bun:test"
import {
  createSessionActivityTracker,
  SESSION_ACTIVITY_MAX_ENTRIES,
  SESSION_ACTIVITY_TTL_MS,
  type V1SessionStatuses,
} from "./session-activity"

function trackerAt(clock: { now: number }) {
  return createSessionActivityTracker(() => clock.now)
}

describe("createSessionActivityTracker", () => {
  it("marks a session busy on the execution envelope and clears it when the turn ends", () => {
    const clock = { now: 1_000 }
    const tracker = trackerAt(clock)

    expect(tracker.observe("session.execution.started", "ses_a")).toBe(true)
    expect(tracker.statuses()).toEqual({ ses_a: { type: "busy" } } satisfies V1SessionStatuses)

    expect(tracker.observe("session.execution.succeeded", "ses_a")).toBe(true)
    expect(tracker.statuses()).toEqual({})
  })

  it("clears busy state on each terminal execution outcome", () => {
    for (const ended of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
      // given a session that is mid-turn
      const tracker = createSessionActivityTracker()
      tracker.observe("session.execution.started", "ses_a")

      // when the host reports that exact terminal outcome
      expect(tracker.observe(ended, "ses_a")).toBe(true)

      // then the session is no longer reported
      expect(tracker.statuses()).toEqual({})
    }
  })

  it("keeps a multi-step turn busy across step boundaries", () => {
    const tracker = createSessionActivityTracker()
    tracker.observe("session.execution.started", "ses_a")
    // A step ending is not a turn ending; the execution envelope closes the turn.
    tracker.observe("session.step.started", "ses_a")
    tracker.observe("session.step.ended", "ses_a")
    tracker.observe("session.step.streamed", "ses_a")

    expect(tracker.statuses()).toEqual({ ses_a: { type: "busy" } })
  })

  it("treats streamed deltas, tool activity and retries as heartbeats", () => {
    const clock = { now: 0 }
    const tracker = trackerAt(clock)
    tracker.observe("session.execution.started", "ses_a")

    clock.now = SESSION_ACTIVITY_TTL_MS - 1
    for (const heartbeat of [
      "session.text.delta",
      "session.reasoning.delta",
      "session.message.content.updated",
      "session.tool.called",
      "session.tool.progress",
      "session.shell.started",
      "session.retry.scheduled",
    ]) {
      clock.now += 1
      tracker.observe(heartbeat, "ses_a")
    }

    // then the entry never expired while the heartbeats kept arriving
    expect(tracker.statuses()).toEqual({ ses_a: { type: "busy" } })
  })

  it("expires a busy entry once no event has refreshed it for the TTL", () => {
    const clock = { now: 0 }
    const tracker = trackerAt(clock)
    tracker.observe("session.execution.started", "ses_a")

    clock.now = SESSION_ACTIVITY_TTL_MS + 1
    expect(tracker.size()).toBe(1)
    expect(tracker.statuses()).toEqual({})
    expect(tracker.size()).toBe(0)
  })

  it("drops a session immediately on session.deleted", () => {
    const tracker = createSessionActivityTracker()
    tracker.observe("session.execution.started", "ses_a")
    tracker.observe("session.deleted", "ses_a")

    expect(tracker.statuses()).toEqual({})
  })

  it("ignores unrelated events and empty session ids", () => {
    const tracker = createSessionActivityTracker()

    expect(tracker.observe("session.created", "ses_a")).toBe(false)
    expect(tracker.observe("session.execution.started", "")).toBe(false)
    expect(tracker.statuses()).toEqual({})
  })

  it("reports only the sessions that are currently busy", () => {
    const tracker = createSessionActivityTracker()
    tracker.observe("session.execution.started", "ses_a")
    tracker.observe("session.execution.started", "ses_b")
    tracker.observe("session.execution.succeeded", "ses_a")

    expect(tracker.statuses()).toEqual({ ses_b: { type: "busy" } })
  })

  it("evicts the least recently active session past the entry cap", () => {
    const clock = { now: 0 }
    const tracker = trackerAt(clock)
    for (let index = 0; index <= SESSION_ACTIVITY_MAX_ENTRIES; index += 1) {
      clock.now += 1
      tracker.observe("session.execution.started", `ses_${index}`)
    }

    // then the map is capped and the first observed session is the one dropped
    expect(tracker.size()).toBe(SESSION_ACTIVITY_MAX_ENTRIES)
    const statuses = tracker.statuses()
    expect(statuses.ses_0).toBeUndefined()
    expect(statuses[`ses_${SESSION_ACTIVITY_MAX_ENTRIES}`]).toEqual({ type: "busy" })
  })

  it("refreshes eviction order on re-observation instead of keeping first-seen order", () => {
    const clock = { now: 0 }
    const tracker = trackerAt(clock)
    tracker.observe("session.execution.started", "ses_old")
    for (let index = 0; index < SESSION_ACTIVITY_MAX_ENTRIES - 1; index += 1) {
      clock.now += 1
      tracker.observe("session.execution.started", `ses_${index}`)
    }

    // when the oldest session reports activity again
    clock.now += 1
    tracker.observe("session.step.streamed", "ses_old")
    tracker.observe("session.execution.started", "ses_newest")

    // then the least recently active session is evicted, not the re-observed one
    const statuses = tracker.statuses()
    expect(statuses.ses_old).toEqual({ type: "busy" })
    expect(statuses.ses_0).toBeUndefined()
  })
})
