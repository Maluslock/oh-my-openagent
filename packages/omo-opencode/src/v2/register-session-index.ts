// packages/omo-opencode/src/v2/register-session-index.ts
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { isRecord, log } from "../shared"
import { setSessionIndexSource } from "../tools/session-manager/storage"
import { observeSessionActivity } from "./session-activity"
import {
  parseSessionIndex,
  selectSessionIndexEntries,
  sessionIndexIds,
  toSessionMetadata,
  upsertSessionIndexEntry,
  SESSION_INDEX_STORAGE_KEY,
  type SessionIndexEntry,
} from "./session-index"
import { omoRuntimeKeyFor } from "./register-tools"

type V2Setup = NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>
type V2Context = Parameters<V2Setup>[0]

/**
 * Keep omo's session index fresh on V2 and serve it to the session tools.
 *
 * The index records every session omo observes - through the `prompt` hook and the host event
 * stream - and is persisted in `ctx.storage` so it survives restarts (probe-verified). The storage
 * key is plugin+location scoped, so the installed source aggregates every registered index and lets
 * the directory filter do the work; that keeps `session_list` correct even when one process serves
 * several project locations.
 *
 * Capacity and freshness trade-offs are deliberate: entries are bounded
 * (`SESSION_INDEX_MAX_ENTRIES`), writes are coalesced, and titles are enriched from
 * `ctx.session.get` without blocking the hook.
 */

export type RegisterSessionIndexDeps = {
  /** Test seam: overrides the clock used for entry timestamps. */
  readonly now?: () => number
}

const FLUSH_DELAY_MS = 1_500

/** Every registered index in this process, keyed by runtime key. */
const indexes = new Map<string, () => SessionIndexEntry[]>()
const disposers = new Map<string, () => Promise<void>>()
let sourceInstalled = false

/** Test seam: clears the memoized indexes and uninstalls the enumeration source. */
export function resetOmoSessionIndexCache(): void {
  indexes.clear()
  sourceInstalled = false
  setSessionIndexSource(null)
}

/**
 * Hook events and event envelopes are unions, so fields are read behind helpers typed for
 * `unknown`: narrowing a union member with `isRecord` does not expose fields some members lack.
 */
function sessionIDOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.sessionID === "string" ? value.sessionID : undefined
}

function directoryOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.directory === "string" && value.directory.length > 0 ? value.directory : undefined
}

function readAllIndexedEntries(): SessionIndexEntry[] {
  const all: SessionIndexEntry[] = []
  for (const read of indexes.values()) all.push(...read())
  return all
}

function installSessionIndexSource(): void {
  if (sourceInstalled || indexes.size === 0) return
  sourceInstalled = true
  setSessionIndexSource({
    listMainSessions: async (directory) =>
      selectSessionIndexEntries(readAllIndexedEntries(), directory === undefined ? {} : { directory }).map(toSessionMetadata),
    listAllSessionIds: async () => sessionIndexIds(readAllIndexedEntries()),
  })
}

export async function registerOmoSessionIndex(
  ctx: V2Context,
  pluginConfig: OhMyOpenCodeConfig,
  deps: RegisterSessionIndexDeps = {},
): Promise<void> {
  const storage = ctx.storage
  if (typeof storage?.get !== "function" || typeof storage?.set !== "function") {
    log("[v2] session index skipped", { reason: "ctx.storage.get/set unavailable" })
    return
  }

  const key = omoRuntimeKeyFor(ctx, pluginConfig)
  if (indexes.has(key)) return

  const directory = ctx.location.directory
  const now = deps.now ?? (() => Date.now())
  let entries = parseSessionIndex(await storage.get(SESSION_INDEX_STORAGE_KEY).catch(() => undefined))
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let pendingFlush: Promise<void> = Promise.resolve()
  let disposed = false

  const flush = async (): Promise<void> => {
    pendingFlush = pendingFlush
      .then(() => storage.set(SESSION_INDEX_STORAGE_KEY, entries))
      .catch((error: unknown) => {
        log("[v2] session index flush failed", { error: error instanceof Error ? error.message : String(error) })
      })
    await pendingFlush
  }

  const scheduleFlush = (): void => {
    if (disposed || flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flush()
    }, FLUSH_DELAY_MS)
    // A pending timer must not keep the host process alive on shutdown.
    if (typeof flushTimer === "object" && flushTimer !== null && "unref" in flushTimer) flushTimer.unref()
  }

  const record = (patch: Parameters<typeof upsertSessionIndexEntry>[1]): void => {
    if (disposed) return
    entries = upsertSessionIndexEntry(entries, { ...patch, updated: patch.updated ?? now() }, { now: now() })
    scheduleFlush()
  }

  const enrichFromHost = async (sessionID: string): Promise<void> => {
    try {
      const raw = await ctx.session.get({ sessionID })
      const info = isRecord(raw) ? raw : undefined
      const time = isRecord(info?.time) ? info.time : undefined
      record({
        id: sessionID,
        directory,
        ...(typeof info?.projectID === "string" ? { projectID: info.projectID } : {}),
        ...(typeof info?.parentID === "string" ? { parentID: info.parentID } : {}),
        ...(typeof info?.title === "string" ? { title: info.title } : {}),
        ...(typeof info?.agent === "string" ? { agent: info.agent } : {}),
        ...(typeof time?.created === "number" ? { created: time.created } : {}),
        ...(typeof time?.updated === "number" ? { updated: time.updated } : {}),
      })
    } catch (error) {
      log("[v2] session index enrichment failed", { sessionID, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const readEntries = (): SessionIndexEntry[] => entries
  indexes.set(key, readEntries)
  installSessionIndexSource()

  const controller = new AbortController()
  const recordSession = (sessionID: string, rawDirectory?: unknown): void => {
    record({
      id: sessionID,
      directory: typeof rawDirectory === "string" && rawDirectory.length > 0 ? rawDirectory : directory,
    })
  }

  if (typeof ctx.session?.hook === "function") {
    await ctx.session.hook("prompt", (event: unknown) => {
      const sessionID = sessionIDOf(event)
      if (sessionID === undefined) return
      recordSession(sessionID)
      void enrichFromHost(sessionID)
    }).catch((error: unknown) => {
      log("[v2] session index could not register the prompt hook", { error: error instanceof Error ? error.message : String(error) })
    })
  }

  if (typeof ctx.event?.subscribe === "function") {
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed) break
          const event = isRecord(raw) ? raw : undefined
          const sessionID = sessionIDOf(event?.data)
          if (sessionID === undefined) continue
          // The activity tracker rides this subscription rather than opening a third event stream:
          // it needs exactly the same (event type, sessionID) pair this loop already extracts.
          if (typeof event?.type === "string") observeSessionActivity(event.type, sessionID)
          recordSession(sessionID, directoryOf(event?.location))
        }
      } catch (error) {
        if (!disposed) log("[v2] session index event feed stopped", { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }

  log("[v2] session index ready", { entries: entries.length, directory })

  const dispose = async (): Promise<void> => {
    disposed = true
    controller.abort()
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    indexes.delete(key)
    // Uninstall when the last index goes away, or the enumeration source would keep answering with
    // an empty list and mask the SDK/file fallbacks for every other consumer in this process.
    if (indexes.size === 0) {
      sourceInstalled = false
      setSessionIndexSource(null)
    }
    await flush()
  }
  disposers.set(key, dispose)
}

/** Test seam: runs the disposer registered for a runtime key. */
export async function disposeOmoSessionIndex(key: string): Promise<void> {
  const dispose = disposers.get(key)
  disposers.delete(key)
  if (dispose !== undefined) await dispose()
}
