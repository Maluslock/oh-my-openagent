// packages/omo-opencode/src/v2/session-index.ts
import type { SessionMetadata } from "../tools/session-manager/types"

/**
 * omo's own session index for V2.
 *
 * V2 exposes no session enumeration to server plugins: `ctx.session` is a `Pick` of `SessionApi`
 * without `list` (checked in the types and at runtime), `ctx.storage` is a plugin-namespaced KV and
 * `ctx.rpc` cannot call host methods. `session_list` and the all-sessions mode of `session_search`
 * therefore need a list omo maintains itself, fed by the events the host does deliver
 * (`ctx.event.subscribe` carries `sessionID`, per the storage/events probe).
 *
 * The index is deliberately small and lossy: it records sessions omo has seen since it loaded, so
 * sessions that predate the plugin (or that were created while it was not running) are absent. There
 * is no backfill without an enumeration API; a TUI companion plugin is the only shipped way to get a
 * complete list.
 */

export type SessionIndexEntry = {
  readonly id: string
  readonly directory: string
  readonly projectID?: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly created: number
  readonly updated: number
}

export type SessionIndexPatch = {
  readonly id: string
  readonly directory?: string
  readonly projectID?: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly created?: number
  readonly updated?: number
}

export const SESSION_INDEX_STORAGE_KEY = "v2/session-index"

/** Bounded so the single storage value cannot grow without limit. */
export const SESSION_INDEX_MAX_ENTRIES = 400

function isEntry(value: unknown): value is SessionIndexEntry {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === "string"
    && typeof record.directory === "string"
    && typeof record.created === "number"
    && typeof record.updated === "number"
}

/** Tolerates a missing, malformed or partially-written value. */
export function parseSessionIndex(raw: unknown): SessionIndexEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isEntry)
}

/**
 * Insert or update one entry and keep the index newest-first and bounded.
 *
 * A later patch only fills fields it actually carries, so an event without a title cannot erase a
 * title learned from `ctx.session.get`, and `created` is sticky.
 */
export function upsertSessionIndexEntry(
  entries: readonly SessionIndexEntry[],
  patch: SessionIndexPatch,
  options: { now?: number; max?: number } = {},
): SessionIndexEntry[] {
  const now = options.now ?? Date.now()
  const max = options.max ?? SESSION_INDEX_MAX_ENTRIES
  const existing = entries.find((entry) => entry.id === patch.id)

  const next: SessionIndexEntry = {
    id: patch.id,
    directory: patch.directory ?? existing?.directory ?? "",
    // `created` is sticky: a later patch cannot rewrite when the session started.
    created: existing?.created ?? patch.created ?? now,
    updated: Math.max(patch.updated ?? now, existing?.updated ?? 0),
    ...pickDefined("projectID", patch.projectID ?? existing?.projectID),
    ...pickDefined("parentID", patch.parentID ?? existing?.parentID),
    ...pickDefined("title", patch.title ?? existing?.title),
    ...pickDefined("agent", patch.agent ?? existing?.agent),
  }

  const others = entries.filter((entry) => entry.id !== patch.id)
  return [next, ...others]
    .sort((left, right) => right.updated - left.updated)
    .slice(0, max)
}

function pickDefined<K extends string>(key: K, value: unknown): Record<K, string> | Record<string, never> {
  return typeof value === "string" && value.length > 0 ? { [key]: value } as Record<K, string> : {}
}

/** Entries for one project directory (or all of them), newest first. */
export function selectSessionIndexEntries(
  entries: readonly SessionIndexEntry[],
  options: { directory?: string; limit?: number } = {},
): SessionIndexEntry[] {
  const filtered = options.directory === undefined
    ? [...entries]
    : entries.filter((entry) => entry.directory === options.directory)
  const sorted = filtered.sort((left, right) => right.updated - left.updated)
  return options.limit !== undefined && options.limit > 0 ? sorted.slice(0, options.limit) : sorted
}

export function sessionIndexIds(entries: readonly SessionIndexEntry[]): string[] {
  return selectSessionIndexEntries(entries).map((entry) => entry.id)
}

/** Project an entry onto the V1 `SessionMetadata` shape the session tools consume. */
export function toSessionMetadata(entry: SessionIndexEntry): SessionMetadata {
  return {
    id: entry.id,
    projectID: entry.projectID ?? "unknown",
    directory: entry.directory,
    time: { created: entry.created, updated: entry.updated },
    ...pickDefined("title", entry.title),
    ...pickDefined("parentID", entry.parentID),
  } as SessionMetadata
}
