// packages/omo-opencode/src/v2/register-tools.ts
import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OhMyOpenCodeConfig } from "../config"
import { createManagers } from "../create-managers"
import { createRuntimeTmuxConfig } from "../create-runtime-tmux-config"
import { createTools } from "../create-tools"
import { registerManagerForCleanup, unregisterManagerForCleanup } from "../features/background-agent/process-cleanup"
import { createModelCacheState } from "../plugin-state"
import { log } from "../shared"
import { createV2AskResolver } from "./ask-resolver"
import { createV1ClientShim, type V2ClientShimSource } from "./client-shim"
import { ArgSchemaProvenanceError, toV2Tool } from "./tool-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

/** Exported so the request-config bridge can resolve bare V1 tool names to `omo_*` ids. */
export const TOOL_NAMESPACE = "omo"
const NAMESPACE = TOOL_NAMESPACE

/**
 * Tools that dereference a host surface with **no usable V2 mapping**, so they stay out of the V2
 * registry (advertising them would surface a tool that throws or degrades on every call).
 * Everything the shim can serve is registered instead — see `createV1ClientShim`.
 *
 * Still excluded:
 * - `skill` — blocked by the V2 ToolContext `ask` gap (fail-closed). The host already ships its own
 *   `skill` tool, which loads omo-registered skills, so the duplicate stays out deliberately.
 *
 * Unlocked, for the record — each of these once looked impossible:
 * - nothing in the session or task families. `session_read`/`session_info` only need one session's
 *   messages, which the shim serves from `ctx.session.context`. `session_list` and the all-sessions
 *   mode of `session_search` need enumeration, which V2 withholds from server plugins, so they run
 *   against omo's own persisted index (`register-session-index.ts`); without that source they
 *   degrade to "no sessions found" instead of failing.
 * - `task_create`/`task_update`: their storage is plain JSON files, and the V1 todo sync is
 *   fail-soft by construction (it reads the shim's empty `session.todo` stub, then cannot resolve
 *   `opencode/session/todo` on V2 and returns). Their list id is pinned per location because V2
 *   serves many projects from one process - see `withLocationTaskListId`.
 * - `monitor_*`: process spawning goes through the repo's own spawn shim, output injection goes
 *   through the shared prompt gate (which dispatches into the shim), and the `ctx.ask` bash gate is
 *   answered by `v2/ask-resolver.ts` from `monitor.allowed_commands`.
 * - `team_*`: ten of the twelve factories accept `client` and never read it (`void client`), and
 *   both real uses are already V2-native. Member sessions spawn through the background manager,
 *   whose `session.create`/`get`/`abort`/`todo`/`status` calls the shim serves;
 *   `team_send_message` live delivery goes through the shared prompt gate. tmux layout is a no-op
 *   unless `tmux_visualization` is enabled, and worktree orchestration is plain git.
 *
 * Client-free tools (`grep`, `glob`, `edit`, `interactive_bash`, goal tools) stay registered.
 */
export const CLIENT_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  "skill",
])

/**
 * Tools unlocked by the V1 client shim: registered in V2, but still dependent on the shim at
 * execute time. Kept as an explicit set so the registration tests can pin the unlocked surface.
 */
export const SHIM_UNLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "call_omo_agent",
  "session_read",
  "session_list",
  "session_search",
  "session_info",
  "task_create",
  "task_update",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "team_create",
  "team_delete",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
  "team_list",
  "look_at",
  "task",
  "background_output",
  "background_cancel",
  "skill_mcp",
])

type RegisterToolsDeps = {
  readonly createManagers: (args: Parameters<typeof createManagers>[0]) => ReturnType<typeof createManagers>
  readonly createTools: (args: Parameters<typeof createTools>[0]) => ReturnType<typeof createTools>
}

const defaultDeps: RegisterToolsDeps = { createManagers, createTools }

/**
 * Order-independent serialization so the cache key is stable regardless of JSON key order.
 * `pluginConfig` is plain JSON-derived data, so no functions/cycles are expected.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
}

/**
 * `createManagers` has process-global side effects: it starts a non-unref'd TUI heartbeat
 * interval, constructs a BackgroundManager, and registers a process-level shutdown closure.
 * `setup` can run more than once (reloads), so managers are memoized per directory **and
 * construction-relevant config**. The cache holds at most one live manager set per directory:
 * when the fingerprint changes, the previous set is disposed and its global shutdown closure
 * unregistered before fresh managers are built, so reloads cannot pile up heartbeat intervals,
 * pollers, or shutdown handlers.
 */
type LifecycleTarget = { shutdown: () => void | Promise<void> }

type OmoToolsResult = Awaited<ReturnType<typeof createTools>>

type CachedRuntime = {
  managers: ReturnType<typeof createManagers>
  toolsResult: OmoToolsResult
  client: unknown
  cleanupTargets: Set<LifecycleTarget>
}

/** The managers + tool registry for one `(directory, context, config)` triple. */
export type OmoRuntime = {
  managers: ReturnType<typeof createManagers>
  toolsResult: OmoToolsResult
  /** The V1 client shim this runtime was built with (shared with the hook assembly). */
  client: unknown
}

const runtimeCache = new Map<string, CachedRuntime>()

/**
 * `createManagers` captures the plugin context's `client`, so a manager set built for one
 * `setup(ctx)` must not be reused for a later one: on reload the previous client belongs to a
 * disposed plugin registration. The generation is keyed by context identity, which keeps the
 * memoization working for repeated calls with the same context (idempotent reloads, tests) while
 * forcing a dispose+rebuild when a new context appears.
 */
const contextGenerations = new Map<object, number>()
let contextGenerationCounter = 0

function contextGeneration(ctx: object): number {
  const existing = contextGenerations.get(ctx)
  if (existing !== undefined) return existing
  const next = ++contextGenerationCounter
  contextGenerations.set(ctx, next)
  return next
}

function managersCacheKey(directory: string, pluginConfig: OhMyOpenCodeConfig, generation: number): string {
  return `${directory}\u0000${generation}\u0000${stableStringify(pluginConfig)}`
}

/**
 * Best-effort, awaited teardown of one manager set. `createManagers` exposes no single
 * `dispose`/`stop`/`stopAll` on its returned object; each member has its own lifecycle API:
 * - `tmuxSessionManager.cleanup()`
 * - `backgroundManager.shutdown()`
 * - `skillMcpManager.disconnectAll()`
 * - `monitorManager.shutdown()`
 * - `tuiStateMirror.stop()` (clears the non-unref'd heartbeat interval)
 * The method list also accepts `stop`/`dispose`/`stopAll` so a future/test-seam manager is torn down too.
 */
async function invokeLifecycle(target: unknown, methods: readonly string[]): Promise<void> {
  if (typeof target !== "object" || target === null) return
  for (const method of methods) {
    const fn = (target as Record<string, unknown>)[method]
    if (typeof fn !== "function") continue
    try {
      await Promise.resolve((fn as () => unknown).call(target))
    } catch (error) {
      log(`[v2] manager ${method}() during fingerprint-change dispose error:`, error)
    }
    return
  }
}

async function disposeManagers(entry: CachedRuntime): Promise<void> {
  const m = entry.managers as unknown as Record<string, unknown>
  await Promise.all([
    invokeLifecycle(m.tmuxSessionManager, ["cleanup", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.backgroundManager, ["shutdown", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.skillMcpManager, ["disconnectAll", "shutdown", "stop", "dispose"]),
    invokeLifecycle(m.monitorManager, ["shutdown", "stop", "dispose", "stopAll"]),
    invokeLifecycle(m.tuiStateMirror, ["stop", "dispose", "shutdown"]),
  ])
  // Unregister the process-global shutdown closure `createManagers` registered for this set.
  for (const target of entry.cleanupTargets) unregisterManagerForCleanup(target)
  entry.cleanupTargets.clear()
}

/**
 * Load (or reuse) the managers + tool registry for one `(directory, context, config)` triple.
 * Both `registerOmoTools` and `registerOmoHooks` go through here so a single `setup` never builds
 * two manager sets (each `createManagers` starts a heartbeat interval, background pollers, and a
 * process-global shutdown closure).
 */
async function loadOmoRuntime(
  directory: string,
  pluginConfig: OhMyOpenCodeConfig,
  client: unknown,
  generation: number,
  deps: RegisterToolsDeps,
): Promise<OmoRuntime> {
  const key = managersCacheKey(directory, pluginConfig, generation)
  const cached = runtimeCache.get(key)
  if (cached !== undefined) return cached

  // Bound the cache to one entry per directory: evict + dispose any other fingerprint first.
  const prefix = `${directory}\u0000`
  for (const [existingKey, entry] of [...runtimeCache]) {
    if (!existingKey.startsWith(prefix)) continue
    runtimeCache.delete(existingKey)
    await disposeManagers(entry)
  }

  const cleanupTargets = new Set<LifecycleTarget>()
  const managers = deps.createManagers({
    ctx: { directory, client } as never,
    pluginConfig,
    tmuxConfig: createRuntimeTmuxConfig(pluginConfig),
    modelCacheState: createModelCacheState(),
    backgroundNotificationHookEnabled: false,
    deps: {
      registerManagerForCleanupFn: (target: LifecycleTarget) => {
        registerManagerForCleanup(target)
        cleanupTargets.add(target)
      },
    },
  })
  const toolsResult = await deps.createTools({
    ctx: { directory, client } as never,
    pluginConfig,
    managers,
  })
  const entry: CachedRuntime = { managers, toolsResult, client, cleanupTargets }
  runtimeCache.set(key, entry)
  return entry
}

/** Cache key for one `(directory, context identity, config)` triple. */
export function omoRuntimeKeyFor(ctx: V2Ctx, pluginConfig: OhMyOpenCodeConfig): string {
  return managersCacheKey(ctx.location.directory, pluginConfig, contextGeneration(ctx))
}

/** Resolve the runtime for a V2 context, creating the client shim and generation key. */
/**
 * Pin the task store to the session's project.
 *
 * `getTaskDir` falls back to `<opencode config dir>/tasks/<basename(process.cwd())>` when no list id
 * is configured. That was fine for a per-project V1 process, but V2 serves every project location
 * from one process, so the fallback would mix all projects into a single task list. When the user
 * has not chosen an id (and no env override is set), derive it from the location instead; an explicit
 * `sisyphus.tasks.task_list_id`, `sisyphus.tasks.storage_path` or `ULTRAWORK_TASK_LIST_ID` still wins.
 */
export function withLocationTaskListId(
  config: OhMyOpenCodeConfig,
  directory: string,
): OhMyOpenCodeConfig {
  if (typeof config.sisyphus?.tasks?.task_list_id === "string" && config.sisyphus.tasks.task_list_id.trim().length > 0) {
    return config
  }
  if (typeof process.env.ULTRAWORK_TASK_LIST_ID === "string" && process.env.ULTRAWORK_TASK_LIST_ID.trim().length > 0) {
    return config
  }
  const listId = basename(directory)
  if (listId.length === 0) return config
  const tasks = config.sisyphus?.tasks
  return {
    ...config,
    sisyphus: { ...config.sisyphus, tasks: { ...(tasks ?? { claude_code_compat: true }), task_list_id: listId } },
  }
}

export async function resolveOmoRuntime(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  deps: Partial<RegisterToolsDeps> = {},
): Promise<OmoRuntime> {
  const directory = ctx.location.directory
  const resolvedDeps: RegisterToolsDeps = { ...defaultDeps, ...deps }
  // The V2 domain methods use branded ids and optional-input signatures that TypeScript's
  // contravariant parameter checking rejects against the structural shim type; the runtime shape
  // is pinned by `client-shim.test.ts` and the P2.5 probe, so bridge the declarations here.
  const client = createV1ClientShim(ctx as unknown as V2ClientShimSource)
  return loadOmoRuntime(directory, withLocationTaskListId(pluginConfig, directory), client, contextGeneration(ctx), resolvedDeps)
}

/** Test seam: clears the memoized runtime (production never calls this). */
export function resetOmoManagersCache(): void {
  runtimeCache.clear()
  contextGenerations.clear()
  contextGenerationCounter = 0
}

/**
 * Register omo's V1 tool registry into the V2 tool domain.
 *
 * Probed facts this relies on:
 * - V2 `Context` has no `client`; `createV1ClientShim(ctx)` rebuilds the V1 surface the tool
 *   factories and managers dereference at execute time. Tools whose client usage has no V2
 *   mapping stay out — see `CLIENT_DEPENDENT_TOOLS` / `SHIM_UNLOCKED_TOOLS`.
 * - Effective V2 tool id = `${options.namespace}_${name}` (namespace separator `_`), as
 *   returned by `ctx.tool.list()` and accepted by `editor.get`. Built-ins such as
 *   `glob`/`grep`/`skill` are never shadowed because every omo tool is namespaced.
 *
 * `setup` may run more than once, so registration is idempotent: a tool is only added when
 * `editor.get(id)` is absent and otherwise merged via `editor.update(id, ...)`.
 */
export async function registerOmoTools(
  ctx: V2Ctx,
  pluginConfig: OhMyOpenCodeConfig,
  deps: Partial<RegisterToolsDeps> = {},
): Promise<void> {
  // Guard before assembling managers: a malformed/mock context without the tool domain must
  // not start manager side effects (background polling, TUI heartbeat) for nothing.
  if (typeof ctx.tool?.transform !== "function") {
    log("[v2] tool registration skipped", { reason: "ctx.tool.transform unavailable" })
    return
  }

  const directory = ctx.location.directory
  // V2 has no interactive permission prompt; this resolver keeps the monitor's bash gate usable
  // through `monitor.allowed_commands` and denies everything else explicitly.
  const askResolver = createV2AskResolver(pluginConfig)
  const { toolsResult } = await resolveOmoRuntime(ctx, pluginConfig, deps)
  const filteredTools = toolsResult.filteredTools

  // `ToolsRecord` values are typed against @opencode-ai/plugin's vendored zod (4.1.8) while
  // `toV2Tool` is typed against this package's zod (4.4.3). The runtime shape is identical
  // (`args` is a ZodRawShape), so bridge the two declarations without converting the schema.
  type SourceTool = { description: string; args: never; execute: (a: unknown, c: unknown) => Promise<unknown> }

  const registered: string[] = []
  const skipped: string[] = []
  const built = Object.entries(filteredTools).flatMap(([name, def]) => {
    if (CLIENT_DEPENDENT_TOOLS.has(name)) {
      skipped.push(name)
      return []
    }
    registered.push(name)
    try {
      return [toV2Tool(name, def as unknown as SourceTool, { namespace: NAMESPACE, directory, ask: askResolver })]
    } catch (error) {
      if (error instanceof ArgSchemaProvenanceError) {
        log("[v2] FATAL: refusing to register tool with mismatched arg-schema provenance", {
          name,
          offendingArgs: error.offendingArgs,
        })
      }
      throw error
    }
  })

  await ctx.tool.transform((editor) => {
    editor.namespace({ name: NAMESPACE, description: "oh-my-openagent tools" })
    for (const tool of built) {
      // Idempotent: `setup` can run more than once, and the effective id carries the namespace.
      const id = `${NAMESPACE}_${tool.name}`
      const existing = editor.get(id)
      if (existing === undefined) editor.add(tool as never)
      else editor.update(id, (t) => Object.assign(t, tool as never))
    }
  })

  log("[v2] tools registered", {
    registered: registered.length,
    skipped: skipped.length,
    skippedTools: skipped,
  })
}
