import type { PluginInput } from "@opencode-ai/plugin"
import { isSqliteBackend } from "../../shared/opencode-storage-detection"
import { log } from "../../shared"
import { getFileAllSessions, getFileMainSessions, fileSessionExists, getFileSessionInfo, getFileSessionMessages, getFileSessionTodos, getFileSessionTranscript } from "./file-storage"
import { getSdkAllSessions, getSdkMainSessions, getSdkSessionMessages, getSdkSessionTodos, sdkSessionExists, shouldFallbackFromSdkError, type GlobalSessionClient } from "./sdk-storage"
import { getSqliteAllSessionIds, getSqliteMainSessions, sqliteSessionExists } from "./sqlite-storage"
import type { SessionInfo, SessionMessage, SessionMetadata, TodoItem } from "./types"
import { describeSessionError } from "./session-error"

// A session that exists only in OpenCode's legacy JSON storage is listed, but the SQLite server answers
// NotFoundError for it (#5854). For a single session that means "not in the SDK", so the reader goes on to
// file storage, exactly as it does for an SDK read that came back empty.
function isSdkSessionNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError"
}

function shouldReadFileSession(error: unknown): boolean {
  return shouldFallbackFromSdkError(error) || isSdkSessionNotFound(error)
}

export interface GetMainSessionsOptions {
  directory?: string
  limit?: number
}

// In multi-project server mode (opencode web / opencode serve) ctx.directory is the
// filesystem root "/", which never matches a stored session.directory. Treat it as
// "no project filter" so every session is listed instead of silently dropping all of them.
function normalizeProjectFilter(directory?: string): string | undefined {
  if (directory === "/") return undefined
  return directory
}

function mergeSessionMetadataLists(
  sdkSessions: SessionMetadata[],
  fileSessions: SessionMetadata[],
): SessionMetadata[] {
  const merged = new Map<string, SessionMetadata>()

  for (const session of fileSessions) {
    merged.set(session.id, session)
  }

  for (const session of sdkSessions) {
    merged.set(session.id, session)
  }

  return [...merged.values()].sort((a, b) => b.time.updated - a.time.updated)
}

/**
 * Combine the live enumeration sources with the SQLite backfill. Precedence is highest-first, so a
 * shared id keeps the value from `primary` (or `fileSessions` when the host writes that layout);
 * `sqliteSessions` only contributes ids nothing live has seen, which is the whole point of reading
 * the host store: sessions created before omo loaded.
 */
function mergeSessionMetadataSources(
  primary: SessionMetadata[],
  fileSessions: SessionMetadata[],
  sqliteSessions: SessionMetadata[],
): SessionMetadata[] {
  return mergeSessionMetadataLists(mergeSessionMetadataLists(primary, fileSessions), sqliteSessions)
}

function mergeSessionIds(sdkSessionIds: string[], fileSessionIds: string[]): string[] {
  return [...new Set([...sdkSessionIds, ...fileSessionIds])]
}

// SDK clients for beta mode
let sdkClient: PluginInput["client"] | null = null
let globalSessionClient: GlobalSessionClient | null = null

/**
 * Enumeration seam for hosts where the SDK client cannot list sessions.
 *
 * OpenCode V2 exposes no session listing to server plugins, so `session_list` and the all-sessions
 * mode of `session_search` would otherwise fall through to the legacy file layout and find nothing
 * (measured: 0 sessions). The V2 adapter installs an index-backed source here. When it is absent the
 * pre-existing SDK-then-file behaviour is unchanged, which keeps the V1 host path intact.
 */
export type SessionIndexSource = {
  readonly listMainSessions: (directory?: string) => Promise<SessionMetadata[]>
  readonly listAllSessionIds: () => Promise<string[]>
}

let sessionIndexSource: SessionIndexSource | null = null

export function setSessionIndexSource(source: SessionIndexSource | null): void {
  sessionIndexSource = source
}

export function resetSessionIndexSource(): void {
  sessionIndexSource = null
}

export function setStorageClient(client: PluginInput["client"], globalClient?: GlobalSessionClient): void {
  sdkClient = client
  globalSessionClient = globalClient ?? null
}

export function resetStorageClient(): void {
  sdkClient = null
  globalSessionClient = null
}

export async function getMainSessions(options: GetMainSessionsOptions): Promise<SessionMetadata[]> {
  const directory = normalizeProjectFilter(options.directory)
  // Read the host store first: it is the only source that knows sessions from before omo loaded.
  // It returns [] on a host without a SQLite session table or outside Bun, so this is additive.
  const sqliteSessions = await getSqliteMainSessions(directory)

  if (sessionIndexSource) {
    try {
      const indexed = await sessionIndexSource.listMainSessions(directory)
      const fileSessions = await getFileMainSessions(directory)
      return mergeSessionMetadataSources(indexed, fileSessions, sqliteSessions)
    } catch (error) {
      log("[session-manager] falling back to the SDK/file session list after the index source failed", { error: String(error) })
    }
  }

  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkSessions = await getSdkMainSessions(sdkClient, directory, globalSessionClient ?? undefined, options.limit)
      const fileSessions = await getFileMainSessions(directory)
      return mergeSessionMetadataSources(sdkSessions, fileSessions, sqliteSessions)
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session list after SDK unavailable error", { error: describeSessionError(error) })
    }
  }

  return mergeSessionMetadataSources([], await getFileMainSessions(directory), sqliteSessions)
}

export async function getAllSessions(limit?: number): Promise<string[]> {
  const sqliteIds = await getSqliteAllSessionIds()

  if (sessionIndexSource) {
    try {
      const indexed = await sessionIndexSource.listAllSessionIds()
      const fileSessionIds = await getFileAllSessions()
      return mergeSessionIds(mergeSessionIds(indexed, fileSessionIds), sqliteIds)
    } catch (error) {
      log("[session-manager] falling back to the SDK/file session ids after the index source failed", { error: String(error) })
    }
  }

  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkSessionIds = await getSdkAllSessions(sdkClient, globalSessionClient ?? undefined, limit)
      const fileSessionIds = await getFileAllSessions()
      return mergeSessionIds(mergeSessionIds(sdkSessionIds, fileSessionIds), sqliteIds)
    } catch (error) {
      if (!shouldFallbackFromSdkError(error)) throw error
      log("[session-manager] falling back to file session ids after SDK unavailable error", { error: describeSessionError(error) })
    }
  }

  return mergeSessionIds(await getFileAllSessions(), sqliteIds)
}

export { getMessageDir } from "../../shared/opencode-message-dir"

export async function sessionExists(sessionID: string): Promise<boolean> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const existsInSdk = await sdkSessionExists(sdkClient, sessionID)
      if (existsInSdk) return true
    } catch (error) {
      if (!shouldReadFileSession(error)) throw error
      log("[session-manager] reading file sessionExists after SDK error", { error: describeSessionError(error), sessionID })
    }
  }
  if (await fileSessionExists(sessionID)) return true
  // Last resort: a session the host store knows about but that omo never observed and that has no
  // message directory on disk (the V2 layout). Without this, `session_read` reports "Session not
  // found" for exactly the sessions the backfill just listed.
  return sqliteSessionExists(sessionID)
}

export async function readSessionMessages(sessionID: string): Promise<SessionMessage[]> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkMessages = await getSdkSessionMessages(sdkClient, sessionID)
      if (sdkMessages.length > 0) return sdkMessages
    } catch (error) {
      if (!shouldReadFileSession(error)) throw error
      log("[session-manager] reading file session messages after SDK error", { error: describeSessionError(error), sessionID })
    }
  }

  return getFileSessionMessages(sessionID)
}

export async function readSessionTodos(sessionID: string): Promise<TodoItem[]> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkTodos = await getSdkSessionTodos(sdkClient, sessionID)
      if (sdkTodos.length > 0) return sdkTodos
    } catch (error) {
      if (!shouldReadFileSession(error)) throw error
      log("[session-manager] reading file session todos after SDK error", { error: describeSessionError(error), sessionID })
    }
  }

  return getFileSessionTodos(sessionID)
}

export async function readSessionTranscript(sessionID: string): Promise<number> {
  return getFileSessionTranscript(sessionID)
}

export async function getSessionInfo(sessionID: string): Promise<SessionInfo | null> {
  if (isSqliteBackend() && sdkClient) {
    try {
      const sdkMessages = await getSdkSessionMessages(sdkClient, sessionID)
      if (sdkMessages.length > 0) {
        const agentsUsed = new Set<string>()
        let firstMessage: Date | undefined
        let lastMessage: Date | undefined

        for (const msg of sdkMessages) {
          if (msg.agent) agentsUsed.add(msg.agent)
          if (msg.time?.created) {
            const date = new Date(msg.time.created)
            if (!firstMessage || date < firstMessage) firstMessage = date
            if (!lastMessage || date > lastMessage) lastMessage = date
          }
        }

        const todos = await readSessionTodos(sessionID)
        const transcriptEntries = await readSessionTranscript(sessionID)

        return {
          id: sessionID,
          message_count: sdkMessages.length,
          first_message: firstMessage,
          last_message: lastMessage,
          agents_used: Array.from(agentsUsed),
          has_todos: todos.length > 0,
          has_transcript: transcriptEntries > 0,
          todos,
          transcript_entries: transcriptEntries,
        }
      }
    } catch (error) {
      if (!shouldReadFileSession(error)) throw error
      log("[session-manager] reading file session info after SDK error", { error: describeSessionError(error), sessionID })
    }
  }

  return getFileSessionInfo(sessionID)
}
