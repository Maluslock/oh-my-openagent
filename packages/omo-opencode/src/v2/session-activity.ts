// packages/omo-opencode/src/v2/session-activity.ts
/**
 * V2 has no `session.status` domain method, so the V1 client shim used to answer with an empty map.
 * That is not a harmless stub: the background manager reads an empty map as "every session is gone"
 * and increments `consecutiveMissedPolls` on each poll, so after `MIN_SESSION_GONE_POLLS` (~9s) it
 * treats an actively streaming subagent as finished and stops it. Observed live on a team member
 * session that was interrupted mid-turn (`team member session errored` right after
 * "Task completed via polling (session gone from status)").
 *
 * The host does publish the turn envelope on the event stream (`session.execution.started` ->
 * `session.execution.succeeded|failed|interrupted`; event catalog from the 2.0.15
 * `session-event.d.ts` schema, recorded under `.omo/evidence/.../research/pkgs/`), plus per-step and
 * per-delta heartbeats. Tracking that envelope in-process lets the shim report `busy` for exactly the
 * sessions the host is working on, which is the only signal the manager needs: while a session is
 * busy it resets the missed-poll counter instead of racing to complete the task.
 *
 * Only busy sessions are reported. Reporting `idle` for finished sessions would change the
 * completion path (`sessionMissing` would stay false) for no benefit - absence already means "no
 * longer running" to the manager.
 */

export type V1SessionStatus = { readonly type: string }
export type V1SessionStatuses = Record<string, V1SessionStatus>

/**
 * A busy entry expires when no event has refreshed it for this long. Live sessions stream
 * `session.text.delta` / `session.step.streamed` continuously, so the timestamp stays fresh; the
 * window only has to cover the gap before the first token of a turn. It is deliberately far shorter
 * than the manager's own 45-minute stale timeout, so a subscription that dies mid-turn (crash) stops
 * masking the session after 90s instead of hanging it.
 */
export const SESSION_ACTIVITY_TTL_MS = 90_000

/** Bounded so a long-lived host serving many sessions cannot grow the map without limit. */
export const SESSION_ACTIVITY_MAX_ENTRIES = 500

const BUSY_EVENT_TYPES = new Set([
  "session.execution.started",
  "session.step.started",
  "session.step.streamed",
  "session.text.delta",
  "session.reasoning.delta",
  "session.message.content.updated",
  "session.tool.called",
  "session.tool.progress",
  "session.shell.started",
  "session.retry.scheduled",
])

const ENDED_EVENT_TYPES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
])

export type SessionActivityTracker = {
  /** Records one host event. Returns true when the session's busy state changed. */
  readonly observe: (eventType: string, sessionID: string) => boolean
  /** Drops a session immediately (used by `session.deleted`). */
  readonly forget: (sessionID: string) => void
  /** Busy sessions only, with expired entries pruned. */
  readonly statuses: () => V1SessionStatuses
  readonly clear: () => void
  readonly size: () => number
}

export function createSessionActivityTracker(
  now: () => number = () => Date.now(),
  ttlMs: number = SESSION_ACTIVITY_TTL_MS,
): SessionActivityTracker {
  const busyAt = new Map<string, number>()

  const prune = (): void => {
    const cutoff = now() - ttlMs
    for (const [sessionID, at] of busyAt) {
      if (at < cutoff) busyAt.delete(sessionID)
    }
    // Insertion order is observation order, so the oldest entries are dropped first.
    while (busyAt.size > SESSION_ACTIVITY_MAX_ENTRIES) {
      const oldest = busyAt.keys().next()
      if (oldest.done === true) break
      busyAt.delete(oldest.value)
    }
  }

  return {
    observe: (eventType, sessionID) => {
      if (sessionID.length === 0) return false
      if (ENDED_EVENT_TYPES.has(eventType)) {
        const had = busyAt.delete(sessionID)
        return had
      }
      if (!BUSY_EVENT_TYPES.has(eventType)) return false
      const wasBusy = busyAt.has(sessionID)
      // `Map.set` on an existing key keeps its original position; re-insert so eviction order
      // follows the most recent activity rather than the first observation.
      busyAt.delete(sessionID)
      busyAt.set(sessionID, now())
      prune()
      return !wasBusy
    },
    forget: (sessionID) => {
      busyAt.delete(sessionID)
    },
    statuses: () => {
      prune()
      const statuses: V1SessionStatuses = {}
      for (const sessionID of busyAt.keys()) statuses[sessionID] = { type: "busy" }
      return statuses
    },
    clear: () => {
      busyAt.clear()
    },
    size: () => busyAt.size,
  }
}

/**
 * Process-global tracker: the event subscription that feeds it is per plugin setup, while the client
 * shim that reads it is rebuilt per runtime, so the state cannot live in either one.
 */
const tracker = createSessionActivityTracker()

export function observeSessionActivity(eventType: string, sessionID: string): boolean {
  return tracker.observe(eventType, sessionID)
}

export function sessionActivityStatuses(): V1SessionStatuses {
  return tracker.statuses()
}

/** Test seam: clears the global tracker. */
export function resetSessionActivityForTesting(): void {
  tracker.clear()
}
