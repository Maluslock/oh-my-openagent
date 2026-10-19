// packages/omo-opencode/src/v2/compaction-end-restore.ts
import { isRecord, log } from "../shared"

/**
 * V1's `experimental.compaction.autocontinue` handler, minus the host decision.
 *
 * V1 asked the plugin two things at once: "restore your own state" and "should I resume the turn?"
 * (via `output.enabled`). V2 has no autocontinue hook, but it does emit
 * `session.compaction.started` / `.delta` / `.ended` / `.failed`, so the state-restore half is
 * portable while the resume half stays with the host.
 *
 * Measured on an idle session (see `.omo/evidence/20260923-v2-alignment/live-compaction-restore.md`):
 * after `session.compaction.ended` the only follow-up event is `session.execution.succeeded` - V2
 * does NOT resume the turn by itself. omo therefore must not answer "resume" (there is nowhere to
 * answer), and it must not inject its own continuation prompt here either: the mid-turn case (a
 * compaction that happens while the agent loop is running) was not tested, and injecting into a loop
 * that already continues is exactly the duplicate-injection hazard the shared prompt gate exists to
 * prevent. Continuation stays with omo's existing session-tier hooks, which the event stream drives.
 *
 * What is ported is the part that only touches omo's own state: the compaction context injector's
 * restore (restores the checkpointed agent config) and the todo preserver's restore.
 */

export type CompactionRestoreHooks = {
  readonly compactionContextInjector?: {
    readonly restore?: (sessionID: string) => Promise<boolean>
  } | null
  readonly compactionTodoPreserver?: {
    readonly restore?: (sessionID: string) => Promise<void>
  } | null
}

export type V2EventSubscribe = (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>

export type CompactionEndRestoreOptions = {
  readonly subscribe: V2EventSubscribe
  readonly hooks: CompactionRestoreHooks
  /** Window in which a second `session.compaction.ended` for the same session is ignored. */
  readonly duplicateGuardMs?: number
  readonly onStepError?: (error: unknown, step: string, sessionID: string) => void
  /** Bound on how long `dispose()` waits for the consume loop, matching the event subscription. */
  readonly disposeTimeoutMs?: number
}

export type CompactionEndRestore = {
  readonly dispose: () => Promise<void>
  /** Test seam: resolves when the consume loop has unwound. */
  readonly settled: Promise<void>
}

export const COMPACTION_ENDED_EVENT = "session.compaction.ended"
const DEFAULT_DUPLICATE_GUARD_MS = 5_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The event envelope is a union, so read the session id behind a helper typed for `unknown`. */
export function sessionIDOfEvent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const data = isRecord(value.data) ? value.data : undefined
  return typeof data?.sessionID === "string" ? data.sessionID : undefined
}

export function eventTypeOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.type === "string" ? value.type : undefined
}

export function startCompactionEndRestore(options: CompactionEndRestoreOptions): CompactionEndRestore {
  const controller = new AbortController()
  const duplicateGuardMs = options.duplicateGuardMs ?? DEFAULT_DUPLICATE_GUARD_MS
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  const guarded = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const runStep = async (step: string, sessionID: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      if (options.onStepError !== undefined) options.onStepError(error, step, sessionID)
      else log("[v2] compaction restore step failed", { step, sessionID, error: describeError(error) })
    }
  }

  const settle = async (sessionID: string): Promise<void> => {
    const existing = guarded.get(sessionID)
    if (existing !== undefined) {
      log("[v2] compaction restore suppressed duplicate", { sessionID })
      return
    }
    const timer = setTimeout(() => guarded.delete(sessionID), duplicateGuardMs)
    if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref()
    guarded.set(sessionID, timer)

    const contextRestore = options.hooks.compactionContextInjector?.restore
    const todoRestore = options.hooks.compactionTodoPreserver?.restore
    if (contextRestore === undefined && todoRestore === undefined) return

    if (contextRestore !== undefined) await runStep("compactionContextInjector.restore", sessionID, () => contextRestore(sessionID))
    if (todoRestore !== undefined) await runStep("compactionTodoPreserver.restore", sessionID, () => todoRestore(sessionID))
    log("[v2] compaction ended: omo state restored", { sessionID })
  }

  const consume = async (): Promise<void> => {
    try {
      for await (const raw of options.subscribe({ signal: controller.signal })) {
        if (disposed) break
        if (eventTypeOf(raw) !== COMPACTION_ENDED_EVENT) continue
        const sessionID = sessionIDOfEvent(raw)
        if (sessionID === undefined) continue
        await settle(sessionID)
      }
    } catch (error) {
      if (!disposed) log("[v2] compaction restore feed stopped", { error: describeError(error) })
    }
  }

  const settled = consume()

  return {
    settled,
    dispose: async () => {
      disposed = true
      controller.abort()
      for (const timer of guarded.values()) clearTimeout(timer)
      guarded.clear()
      // A non-cooperative iterable must not hold teardown open: the wait is bounded and logged.
      await Promise.race([
        settled.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            log("[v2] compaction restore loop did not unwind before the dispose timeout", { disposeTimeoutMs })
            resolve()
          }, disposeTimeoutMs)
          if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref()
        }),
      ])
    },
  }
}
