// packages/omo-opencode/src/v2/client-shim.ts
import { isRecord, log } from "../shared"
import { toV1Message, type V1ShimMessage } from "./client-shim-messages"
import { sessionActivityStatuses } from "./session-activity"
import { recordSessionPromptConfig } from "./session-prompt-config"

/**
 * V1-client shim reconstructed from OpenCode V2 plugin domain APIs.
 *
 * V2 has no `client` on its plugin `Context`; it exposes domains (`ctx.session`, `ctx.agent`,
 * `ctx.model`, ...) whose promise shapes differ from the V1 SDK. omo's tool factories capture
 * `client` at construction and dereference it at execute time, so this module rebuilds the
 * subset of the V1 surface those tools use.
 *
 * Grounded in `@opencode/plugin@2.0.11` / `@opencode/client@2.0.11` types plus a live
 * `opencode serve` probe of the same HTTP routes the domains wrap (see
 * `docs/superpowers/notes/2026-09-23-v2-client-shim-findings.md`). Lossy/unavailable pieces
 * are explicit, never silent:
 *
 * - `session.create` forwards `parentID`: the V2 request schema gained the field in the 2.0.30
 *   line and the host honours it over HTTP, so subagent sessions link to their parent again. A
 *   host that ignores it only gets a one-time warning - the created session still comes back, so
 *   the caller is told the link was dropped instead of losing it silently.
 * - `session.summarize` maps onto `ctx.session.compact`, which the plugin session domain exposes
 *   only from 2.0.30 on. Hosts without it (and hosts whose compaction fails) get a REJECTION, not
 *   an `{error}` response: none of the three call sites inspects `response.error`, so a returned
 *   error would be read as "compacted" while the session grows. V1's `providerID`/`modelID`/`auto`
 *   body fields have no V2 counterpart (compact uses the session's own model) and are dropped with
 *   one warning.
 * - `session.prompt` accepts no `agent`/`model`/`system`/`tools`/generation params; the shim
 *   maps `agent`/`model` onto `switchAgent`/`switchModel`, RECORDS `system`/`tools` for the session
 *   so the V2 `context` hook can apply them to the request (`session-prompt-config.ts`), and warns
 *   once about the generation params, which the agent's own registration already carries.
 * - `session.todo` has no V2 domain equivalent and is an honest empty stub. `session.status` has no
 *   domain method either, but is reconstructed from the host event stream so the background manager
 *   does not mistake a live subagent for a gone session (`session-activity.ts`).
 * - `config.get` is an empty stub (V2 has no `config` domain); host-skill resolution falls back.
 * - `tui.showToast` is a logged no-op: V2 exposes no TUI domain to plugins. It must still EXIST,
 *   because `client.tui.showToast(...)` throws while reading `.showToast` off `undefined`, and that
 *   synchronous throw escapes the caller's `.catch()` (observed as a 500 on the session command
 *   route). See `docs/superpowers/notes/2026-09-23-v2-hook-injection-findings.md`.
 */

type Json = Record<string, unknown>

export type V2ClientShimSource = {
  readonly location?: { readonly directory?: string }
  readonly session: {
    readonly get: (input: { readonly sessionID: string }) => Promise<unknown>
    readonly context?: (input: { readonly sessionID: string }) => Promise<unknown>
    readonly create?: (input: Json) => Promise<unknown>
    readonly compact?: (input: { readonly sessionID: string }) => Promise<unknown>
    readonly prompt?: (input: Json) => Promise<unknown>
    readonly interrupt?: (input: { readonly sessionID: string }) => Promise<unknown>
    readonly switchAgent?: (input: { readonly sessionID: string; readonly agent: string }) => Promise<unknown>
    readonly switchModel?: (input: { readonly sessionID: string; readonly model: Json }) => Promise<unknown>
  }
  readonly agent?: { readonly list?: (input?: Json) => Promise<unknown> }
  readonly model?: { readonly list?: (input?: Json) => Promise<unknown> }
}

export type V1ShimSessionInfo = Json & { readonly directory?: string }
export type V1ShimResponse<T> = { data?: T; error?: unknown }

export type V1ShimPromptInput = { path?: { id?: string }; body?: Json }

/** The V1-client surface the shim reproduces. Fields are optional where V2 may lack a domain. */
export type V1ShimClient = {
  session: {
    get: (input: { path?: { id?: string } }) => Promise<V1ShimResponse<V1ShimSessionInfo>>
    create: (input: { body?: Json; query?: Json }) => Promise<V1ShimResponse<V1ShimSessionInfo>>
    messages: (input: { path?: { id?: string }; query?: Json }) => Promise<V1ShimResponse<V1ShimMessage[]>>
    message: (input: { path?: { id?: string; messageID?: string } }) => Promise<V1ShimResponse<V1ShimMessage>>
    abort: (input: { path?: { id?: string } }) => Promise<V1ShimResponse<boolean>>
    status: () => Promise<V1ShimResponse<Json>>
    todo: (input?: Json) => Promise<V1ShimResponse<unknown[]>>
    summarize: (input: { path?: { id?: string }; body?: Json; query?: Json }) => Promise<V1ShimResponse<unknown>>
    promptAsync?: (input: V1ShimPromptInput) => Promise<unknown>
    prompt?: (input: V1ShimPromptInput) => Promise<unknown>
  }
  app: { agents: () => Promise<V1ShimResponse<Json[]>> }
  model: { list: () => Promise<V1ShimResponse<Json[]>> }
  config: { get: () => Promise<V1ShimResponse<Json>> }
  tui: { showToast: (input: { body?: Json }) => Promise<V1ShimResponse<boolean>> }
}

const warned = new Set<string>()

/** Test seam: clears the once-only mapping warnings. */
export function resetClientShimWarningsForTesting(): void {
  warned.clear()
}

function warnOnce(key: string, message: string, detail?: Json): void {
  if (warned.has(key)) return
  warned.add(key)
  log(message, detail)
}

function dataOf(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (isRecord(response) && Array.isArray(response.data)) return response.data
  return []
}

function normalizeSessionInfo(raw: unknown, fallbackDirectory: string): V1ShimSessionInfo {
  const info = isRecord(raw) ? raw : {}
  const location = isRecord(info.location) ? info.location : undefined
  const directory = typeof location?.directory === "string" ? location.directory : fallbackDirectory
  return { ...info, directory }
}

function toV1Agent(raw: unknown): Json {
  const agent = isRecord(raw) ? raw : {}
  const model = isRecord(agent.model) ? agent.model : undefined
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  const modelID = typeof model?.id === "string" ? model.id
    : typeof model?.modelID === "string" ? model.modelID : undefined
  const variant = typeof model?.variant === "string" ? model.variant : undefined
  return {
    ...agent,
    ...(model !== undefined
      ? { model: { providerID, modelID, ...(variant !== undefined ? { variant } : {}) } }
      : {}),
    ...(variant !== undefined ? { variant } : {}),
  }
}

function toV1Model(raw: unknown): Json {
  const model = isRecord(raw) ? raw : {}
  const providerID = typeof model.providerID === "string" ? model.providerID : undefined
  const id = typeof model.id === "string" ? model.id
    : typeof model.modelID === "string" ? model.modelID : undefined
  return { ...model, provider: providerID, id }
}

function promptText(body: Json): string {
  const parts = Array.isArray(body.parts) ? body.parts : []
  const texts: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text)
  }
  if (texts.length > 0) return texts.join("\n\n")
  return typeof body.text === "string" ? body.text : ""
}

function toV2File(part: Json): Json | undefined {
  const mime = typeof part.mime === "string" ? part.mime : undefined
  const url = typeof part.url === "string" ? part.url : undefined
  if (mime === undefined || url === undefined) return undefined
  const name = typeof part.filename === "string" ? part.filename : undefined
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (dataUrl) {
    return {
      data: dataUrl[3] ?? "",
      mime,
      source: { type: "inline" },
      ...(name !== undefined ? { name } : {}),
    }
  }
  return { data: "", mime, source: { type: "uri", uri: url }, ...(name !== undefined ? { name } : {}) }
}

function promptFiles(body: Json): Json[] {
  const parts = Array.isArray(body.parts) ? body.parts : []
  const files: Json[] = []
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "file") continue
    const file = toV2File(part)
    if (file !== undefined) files.push(file)
  }
  return files
}

const UNMAPPABLE_PROMPT_KEYS = ["temperature", "topP", "maxOutputTokens", "options"] as const

/** V1 `session.summarize` body fields with no V2 `ctx.session.compact` counterpart. */
const UNMAPPABLE_SUMMARIZE_KEYS = ["providerID", "modelID", "auto"] as const

/**
 * Build the immutable V1-client-shaped shim for one V2 plugin context.
 *
 * Every V1 response is `{ data }` / `{ data, error }`; domain failures are converted to an
 * `error` field (or an empty `data`) instead of rejecting, matching V1 call sites that branch
 * on `response.error`.
 */
export function createV1ClientShim(source: V2ClientShimSource): Json {
  const directory = typeof source.location?.directory === "string" ? source.location.directory : process.cwd()
  const session = source.session

  const get = async (input: { path?: { id?: string } }): Promise<V1ShimResponse<V1ShimSessionInfo>> => {
    const id = input?.path?.id
    if (typeof id !== "string") return { data: undefined, error: "session.get requires path.id" }
    try {
      return { data: normalizeSessionInfo(await session.get({ sessionID: id }), directory) }
    } catch (error) {
      return { data: undefined, error }
    }
  }

  const create = async (input: { body?: Json; query?: Json }): Promise<V1ShimResponse<V1ShimSessionInfo>> => {
    if (typeof session.create !== "function") return { data: undefined, error: "session.create unavailable" }
    const body = isRecord(input?.body) ? input.body : {}
    const query = isRecord(input?.query) ? input.query : {}
    const queryDirectory = typeof query.directory === "string" ? query.directory : undefined
    const parentID = typeof body.parentID === "string" ? body.parentID : undefined
    const request: Json = {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(parentID !== undefined ? { parentID } : {}),
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
      ...(isRecord(body.model) ? { model: body.model } : {}),
      location: { directory: queryDirectory ?? directory },
    }
    try {
      const created = normalizeSessionInfo(await session.create(request), queryDirectory ?? directory)
      // V2's create input has no `system`/`tools`; hand them to the request-time bridge instead of
      // dropping them, otherwise a delegated session loses its skill/runtime prompt and its tool
      // restrictions (see `session-prompt-config.ts`).
      recordSessionPromptConfig(created.id, { system: body.system, tools: body.tools })
      // Hosts before 2.0.30 have no `parentID` in the request schema and drop the field, so a
      // subagent session would silently lose its parent (and `session_v2.parent_id` stays null,
      // which makes omo's index list the child as a top-level session). Report the drop once
      // instead of failing the create - the caller still gets a usable session.
      if (parentID !== undefined && created.parentID !== parentID) {
        warnOnce(
          "session.create.parentID.ignored",
          "[v2][client-shim] session.create: the host ignored parentID; the subagent session is not linked to its parent",
          { parentID },
        )
      }
      return { data: created }
    } catch (error) {
      return { data: undefined, error }
    }
  }

  const messages = async (input: { path?: { id?: string }; query?: Json }): Promise<V1ShimResponse<V1ShimMessage[]>> => {
    const id = input?.path?.id
    if (typeof id !== "string" || typeof session.context !== "function") return { data: [] }
    try {
      const mapped = dataOf(await session.context({ sessionID: id })).map(toV1Message)
      const limit = input?.query?.limit
      return { data: typeof limit === "number" && limit > 0 ? mapped.slice(-limit) : mapped }
    } catch (error) {
      return { data: [], error }
    }
  }

  // V1 `session.message({path:{id, messageID}})` returns a single message. Two omo consumers use it:
  // the anthropic context-window recovery reader and the `chat.headers` internal-initiator check.
  // V2 has no per-message route the plugin can reach, so it is derived from the message list.
  const message = async (input: { path?: { id?: string; messageID?: string } }): Promise<V1ShimResponse<V1ShimMessage>> => {
    const id = input?.path?.id
    const messageID = input?.path?.messageID
    if (typeof id !== "string" || typeof messageID !== "string") {
      return { data: undefined, error: "session.message requires path.id and path.messageID" }
    }
    const listed = await messages({ path: { id } })
    const found = (listed.data ?? []).find((entry) => {
      const info = isRecord(entry?.info) ? entry.info : undefined
      return info?.id === messageID
    })
    return found === undefined
      ? { data: undefined, error: `session.message: ${messageID} not found in ${id}` }
      : { data: found }
  }

  const abort = async (input: { path?: { id?: string } }): Promise<V1ShimResponse<boolean>> => {
    const id = input?.path?.id
    if (typeof id !== "string" || typeof session.interrupt !== "function") return { data: false }
    try {
      const result = await session.interrupt({ sessionID: id })
      const interrupted = isRecord(result) && typeof result.interrupted === "boolean" ? result.interrupted : true
      return { data: interrupted }
    } catch (error) {
      return { data: false, error }
    }
  }

  // V1 `session.summarize` is the compaction entry point for three call sites: the preemptive
  // compaction trigger, the post-compaction degradation monitor, and the anthropic context-window
  // recovery. Their V2 equivalent is `ctx.session.compact`, which only the 2.0.30 plugin session
  // domain exposes - and which takes no model. Unlike the rest of this shim, a failure REJECTS:
  // those call sites `await` without ever reading `response.error`, so a returned error would be
  // read as success (they mark the session compacted and clear their recovery state) while the
  // session keeps growing past the context window.
  const summarize = async (input: {
    path?: { id?: string }
    body?: Json
    query?: Json
  }): Promise<V1ShimResponse<unknown>> => {
    const id = input?.path?.id
    if (typeof id !== "string") throw new Error("session.summarize requires path.id")
    if (typeof session.compact !== "function") {
      warnOnce(
        "session.summarize.unavailable",
        "[v2][client-shim] session.summarize: this host exposes no session.compact domain; compaction is unavailable",
      )
      throw new Error(
        "session.summarize is not available on this host: the V2 plugin session domain has no compact method (needs @opencode/plugin >= 2.0.30)",
      )
    }
    const body = isRecord(input?.body) ? input.body : {}
    for (const key of UNMAPPABLE_SUMMARIZE_KEYS) {
      if (body[key] !== undefined) {
        warnOnce(
          `session.summarize.${key}`,
          `[v2][client-shim] session.summarize: "${key}" has no V2 compact equivalent and was dropped (compact uses the session's own model)`,
        )
      }
    }
    return { data: await session.compact({ sessionID: id }) }
  }

  const switchTarget = async (sessionID: string, body: Json): Promise<void> => {
    if (typeof body.agent === "string" && typeof session.switchAgent === "function") {
      await session.switchAgent({ sessionID, agent: body.agent })
    }
    if (isRecord(body.model) && typeof session.switchModel === "function") {
      const model: Json = {
        ...(typeof body.model.providerID === "string" ? { providerID: body.model.providerID } : {}),
        ...(typeof body.model.modelID === "string" ? { id: body.model.modelID }
          : typeof body.model.id === "string" ? { id: body.model.id } : {}),
        ...(typeof body.variant === "string" ? { variant: body.variant }
          : typeof body.model.variant === "string" ? { variant: body.model.variant } : {}),
      }
      await session.switchModel({ sessionID, model })
    } else if (typeof body.variant === "string") {
      warnOnce(
        "session.prompt.variant",
        "[v2][client-shim] session.prompt: variant cannot be applied because no model was supplied",
      )
    }
    // V2's prompt body is `{text, files, agents, skills, metadata, delivery, resume}`: the only way
    // `system`/`tools` can still reach the request is the V2 `context` hook, so record them for this
    // session instead of dropping them (the hook registration reads this store).
    recordSessionPromptConfig(sessionID, { system: body.system, tools: body.tools })
    for (const key of UNMAPPABLE_PROMPT_KEYS) {
      if (body[key] !== undefined) {
        warnOnce(
          `session.prompt.${key}`,
          `[v2][client-shim] session.prompt: "${key}" has no V2 prompt equivalent and was dropped`,
        )
      }
    }
  }

  const dispatch = async (
    input: { path?: { id?: string }; body?: Json },
    delivery: "queue" | "steer",
  ): Promise<unknown> => {
    const id = input?.path?.id
    if (typeof id !== "string") throw new Error("session.prompt requires path.id")
    if (typeof session.prompt !== "function") throw new Error("session.prompt is not available on this V2 client")
    const body = isRecord(input?.body) ? input.body : {}
    await switchTarget(id, body)
    const files = promptFiles(body)
    return session.prompt({
      sessionID: id,
      text: promptText(body),
      delivery,
      ...(files.length > 0 ? { files } : {}),
    })
  }

  const sessionShim: V1ShimClient["session"] = {
    get,
    create,
    messages,
    message,
    abort,
    summarize,
    // `session.status` is reconstructed from the host event stream (`session.execution.*` plus the
    // per-step heartbeats) instead of returning an empty map - see `session-activity.ts` for why an
    // empty map makes the background manager stop live subagents. `session.todo` stays a stub: V2
    // exposes no todo domain and the manager's todo check is a no-op.
    status: async (): Promise<V1ShimResponse<Json>> => ({ data: sessionActivityStatuses() }),
    todo: async (): Promise<V1ShimResponse<unknown[]>> => ({ data: [] }),
  }
  // The prompt gate feature-detects `session.prompt` / `session.promptAsync`; only expose them
  // when the host actually provides the V2 prompt method so the gate fails closed ("unavailable")
  // instead of registering a method that always throws.
  if (typeof session.prompt === "function") {
    sessionShim.promptAsync = (input: V1ShimPromptInput) => dispatch(input, "queue")
    sessionShim.prompt = (input: V1ShimPromptInput) => dispatch(input, "steer")
  }

  return {
    session: sessionShim,
    app: {
      agents: async (): Promise<V1ShimResponse<Json[]>> => {
        if (typeof source.agent?.list !== "function") return { data: [] }
        try {
          return { data: dataOf(await source.agent.list({})).map(toV1Agent) }
        } catch (error) {
          return { data: [], error }
        }
      },
    },
    model: {
      list: async (): Promise<V1ShimResponse<Json[]>> => {
        if (typeof source.model?.list !== "function") return { data: [] }
        try {
          return { data: dataOf(await source.model.list({})).map(toV1Model) }
        } catch (error) {
          return { data: [], error }
        }
      },
    },
    // V2 has no `config` domain. `readRuntimeHostSkills` reads `data.skills` and falls back to
    // the on-disk skill set when it is absent.
    config: { get: async (): Promise<V1ShimResponse<Json>> => ({ data: {} }) },
    // V1 hooks toast through `client.tui` (9 call sites). V2 exposes no TUI domain to plugins, so
    // toasts are dropped after one log line per title. The property must be present: reading
    // `.showToast` off `undefined` throws synchronously, before the caller's `.catch()` can see it,
    // and that aborts the surrounding hook chain.
    tui: {
      showToast: async (input: { body?: Json }): Promise<V1ShimResponse<boolean>> => {
        const body = isRecord(input?.body) ? input.body : {}
        const title = typeof body.title === "string" ? body.title : "toast"
        warnOnce(
          `tui.showToast.${title}`,
          `[v2][client-shim] tui.showToast is a no-op on V2 because the plugin API exposes no TUI domain: ${title}`,
        )
        return { data: true }
      },
    },
  }
}
