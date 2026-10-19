// packages/omo-opencode/src/v2/register-tools.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  withLocationTaskListId,
  CLIENT_DEPENDENT_TOOLS,
  SHIM_UNLOCKED_TOOLS,
  registerOmoTools,
  resetOmoManagersCache,
  resolveOmoRuntime,
} from "./register-tools"

type MockTool = {
  name: string
  description: string
  input: unknown
  options: { namespace: string; codemode: false }
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

function createMockEditor() {
  const registry = new Map<string, MockTool>()
  const namespaceCalls: Array<{ name: string; description: string }> = []
  const addCalls: string[] = []
  const updateCalls: string[] = []
  return {
    registry,
    namespaceCalls,
    addCalls,
    updateCalls,
    list: () => [...registry.values()],
    get: (id: string) => registry.get(id),
    namespace: (ns: { name: string; description: string }) => {
      namespaceCalls.push(ns)
    },
    add: (tool: MockTool) => {
      const id = `${tool.options.namespace}_${tool.name}`
      if (registry.has(id)) throw new Error(`duplicate add: ${id}`)
      registry.set(id, { ...tool, id })
      addCalls.push(id)
    },
    update: (id: string, fn: (tool: MockTool) => void) => {
      const tool = registry.get(id)
      if (tool === undefined) throw new Error(`update miss: ${id}`)
      fn(tool)
      updateCalls.push(id)
    },
    remove: (id: string) => registry.delete(id),
  }
}

type MockEditor = ReturnType<typeof createMockEditor>

function createMockCtx(directory: string, editor: MockEditor) {
  return {
    location: { directory },
    // The shim builder inspects `ctx.session`; a real V2 context always has it. `prompt` presence
    // is read at build time (the gate feature-detects it), so the mock exposes it.
    session: { prompt: async () => ({}) },
    agent: { list: async () => ({ location: { directory }, data: [] }) },
    model: { list: async () => ({ location: { directory }, data: [] }) },
    tool: {
      transform: async (callback: (editor: MockEditor) => void) => {
        const returned = callback(editor)
        if (returned !== undefined) throw new Error("transform callback must be synchronous")
        return { dispose: async () => {} }
      },
    },
  } as never
}

function fakeTool(name: string): unknown {
  return {
    description: name,
    args: {},
    execute: async () => ({ title: name, output: name }),
  }
}

function createFakeDeps(tools: Record<string, unknown>) {
  const managers = {
    tmuxSessionManager: {},
    backgroundManager: {},
    skillMcpManager: {},
    configHandler: {},
    modelFallbackControllerAccessor: {},
  }
  let managerCalls = 0
  let lastCtx: unknown
  const deps = {
    createManagers: ((args: { ctx: unknown }) => {
      managerCalls += 1
      lastCtx = args.ctx
      return managers
    }) as never,
    createTools: (async (args: { managers: unknown }) => {
      if (args.managers !== managers) throw new Error("createTools did not receive the memoized managers")
      return { filteredTools: tools }
    }) as never,
  }
  return { deps, getManagerCalls: () => managerCalls, getLastCtx: () => lastCtx }
}

let home: string
let directory: string
let previousHome: string | undefined
let previousXdg: string | undefined

beforeEach(() => {
  previousHome = process.env.HOME
  previousXdg = process.env.XDG_CONFIG_HOME
  home = mkdtempSync(join(tmpdir(), "omo-v2-tools-home-"))
  directory = mkdtempSync(join(tmpdir(), "omo-v2-tools-dir-"))
  // Hermetic: never read the developer's real ~/.omo/omo.jsonc.
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, "xdg")
  resetOmoManagersCache()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  rmSync(home, { recursive: true, force: true })
  rmSync(directory, { recursive: true, force: true })
})

describe("registerOmoTools", () => {
  it("registers client-free tools namespaced under omo with codemode:false", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({ glob: fakeTool("glob"), grep: fakeTool("grep") })

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    expect(editor.namespaceCalls).toEqual([{ name: "omo", description: "oh-my-openagent tools" }])
    expect(editor.addCalls).toEqual(["omo_glob", "omo_grep"])
    for (const id of ["omo_glob", "omo_grep"]) {
      const tool = editor.get(id)
      expect(tool?.options).toEqual({ namespace: "omo", codemode: false })
      expect(typeof tool?.execute).toBe("function")
    }
  })

  it("is idempotent across a second call (update, no duplicate add)", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({ glob: fakeTool("glob"), grep: fakeTool("grep") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, {} as never, deps)

    expect(editor.addCalls).toEqual(["omo_glob", "omo_grep"])
    expect(editor.updateCalls).toEqual(["omo_glob", "omo_grep"])
    expect(editor.registry.size).toBe(2)
  })

  it("registers shim-unlocked tools and keeps unmappable client-dependent tools out", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({
      glob: fakeTool("glob"),
      edit: fakeTool("edit"),
      task: fakeTool("task"),
      call_omo_agent: fakeTool("call_omo_agent"),
      look_at: fakeTool("look_at"),
      background_output: fakeTool("background_output"),
      background_cancel: fakeTool("background_cancel"),
      skill_mcp: fakeTool("skill_mcp"),
      session_read: fakeTool("session_read"),
      session_list: fakeTool("session_list"),
      session_search: fakeTool("session_search"),
      session_info: fakeTool("session_info"),
      task_create: fakeTool("task_create"),
      task_update: fakeTool("task_update"),
      monitor_start: fakeTool("monitor_start"),
      monitor_stop: fakeTool("monitor_stop"),
      monitor_list: fakeTool("monitor_list"),
      monitor_output: fakeTool("monitor_output"),
      team_create: fakeTool("team_create"),
      team_delete: fakeTool("team_delete"),
      team_shutdown_request: fakeTool("team_shutdown_request"),
      team_approve_shutdown: fakeTool("team_approve_shutdown"),
      team_reject_shutdown: fakeTool("team_reject_shutdown"),
      team_send_message: fakeTool("team_send_message"),
      team_task_create: fakeTool("team_task_create"),
      team_task_list: fakeTool("team_task_list"),
      team_task_update: fakeTool("team_task_update"),
      team_task_get: fakeTool("team_task_get"),
      team_status: fakeTool("team_status"),
      team_list: fakeTool("team_list"),
      skill: fakeTool("skill"),
    })

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    expect(editor.addCalls).toEqual([
      "omo_glob",
      "omo_edit",
      "omo_task",
      "omo_call_omo_agent",
      "omo_look_at",
      "omo_background_output",
      "omo_background_cancel",
      "omo_skill_mcp",
      "omo_session_read",
      "omo_session_list",
      "omo_session_search",
      "omo_session_info",
      "omo_task_create",
      "omo_task_update",
      "omo_monitor_start",
      "omo_monitor_stop",
      "omo_monitor_list",
      "omo_monitor_output",
      "omo_team_create",
      "omo_team_delete",
      "omo_team_shutdown_request",
      "omo_team_approve_shutdown",
      "omo_team_reject_shutdown",
      "omo_team_send_message",
      "omo_team_task_create",
      "omo_team_task_list",
      "omo_team_task_update",
      "omo_team_task_get",
      "omo_team_status",
      "omo_team_list",
    ])
    for (const name of SHIM_UNLOCKED_TOOLS) {
      expect(CLIENT_DEPENDENT_TOOLS.has(name)).toBe(false)
      expect(editor.get(`omo_${name}`)).toBeDefined()
    }
    for (const name of ["skill"]) {
      expect(CLIENT_DEPENDENT_TOOLS.has(name)).toBe(true)
      expect(editor.get(`omo_${name}`)).toBeUndefined()
      expect(editor.addCalls).not.toContain(`omo_${name}`)
    }
  })

  it("passes the V1 client shim into createManagers and createTools", async () => {
    const editor = createMockEditor()
    const { deps, getLastCtx } = createFakeDeps({ glob: fakeTool("glob") })
    let toolsCtx: { directory?: string; client?: { session?: Record<string, unknown> } } | undefined
    deps.createTools = (async (args: { ctx: typeof toolsCtx }) => {
      toolsCtx = args.ctx
      return { filteredTools: { glob: fakeTool("glob") } }
    }) as never

    await registerOmoTools(createMockCtx(directory, editor), {} as never, deps)

    for (const ctx of [getLastCtx() as { directory?: string; client?: { session?: Record<string, unknown> } }, toolsCtx]) {
      expect(ctx?.directory).toBe(directory)
      expect(typeof ctx?.client?.session?.get).toBe("function")
      expect(typeof ctx?.client?.session?.promptAsync).toBe("function")
    }
  })

  it("memoizes createManagers per directory across calls", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, {} as never, deps)

    expect(getManagerCalls()).toBe(1)
  })

  it("re-creates managers when the config fingerprint changes for the same directory", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, { monitor: { enabled: true } } as never, deps)

    expect(getManagerCalls()).toBe(2)
  })

  it("disposes the replaced manager set (per-manager lifecycle + cleanup unregister) on fingerprint change", async () => {
    const editor = createMockEditor()
    const stopped: string[] = []
    const cleanupTargets: Array<{ shutdown: () => void }> = []
    let created = 0
    const makeManagers = () => {
      created += 1
      const tag = `mgr${created}`
      return {
        tmuxSessionManager: { cleanup: async () => { stopped.push(`${tag}.cleanup`) } },
        backgroundManager: { shutdown: async () => { stopped.push(`${tag}.shutdown`) } },
        skillMcpManager: { disconnectAll: async () => { stopped.push(`${tag}.disconnectAll`) } },
        monitorManager: { shutdown: async () => { stopped.push(`${tag}.shutdown`) } },
        tuiStateMirror: { stop: () => { stopped.push(`${tag}.stop`) } },
        modelFallbackControllerAccessor: {},
        configHandler: {},
      }
    }
    const deps = {
      createManagers: ((args: { deps?: { registerManagerForCleanupFn?: (t: { shutdown: () => void }) => void } }) => {
        const managers = makeManagers()
        // Simulate createManagers registering its process-global shutdown closure.
        const target = { shutdown: () => {} }
        args.deps?.registerManagerForCleanupFn?.(target)
        cleanupTargets.push(target)
        return managers
      }) as never,
      createTools: (async () => ({ filteredTools: { glob: fakeTool("glob") } })) as never,
    }
    const ctx = createMockCtx(directory, editor)

    await registerOmoTools(ctx, {} as never, deps)
    await registerOmoTools(ctx, { monitor: { enabled: true } } as never, deps)

    expect(stopped).toEqual([
      "mgr1.cleanup",
      "mgr1.shutdown",
      "mgr1.disconnectAll",
      "mgr1.shutdown",
      "mgr1.stop",
    ])
    // `disposeManagers` also called `unregisterManagerForCleanup` on the previous set's global
    // shutdown closure (registered through the injected seam); a clean run proves it didn't throw.
    expect(cleanupTargets).toHaveLength(2)
  })

  it("fails loudly instead of silently skipping when a tool's args use root zod", async () => {
    const editor = createMockEditor()
    const { deps } = createFakeDeps({ glob: { description: "d", args: { pattern: z.string() }, execute: async () => "ok" } })
    const ctx = createMockCtx(directory, editor)

    await expect(registerOmoTools(ctx, {} as never, deps)).rejects.toThrow(/mismatched zod instance.*pattern/)
    // Nothing was added: the failure is loud, not a silent skip.
    expect(editor.addCalls).toEqual([])
    expect(editor.registry.size).toBe(0)
  })

  it("skips manager assembly when the V2 tool domain is unavailable", async () => {
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })

    await expect(
      registerOmoTools({ location: { directory } } as never, {} as never, deps),
    ).resolves.toBeUndefined()
    expect(getManagerCalls()).toBe(0)
  })
})

describe("resolveOmoRuntime", () => {
  it("builds managers and tools once and shares them across callers", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })
    let toolCalls = 0
    deps.createTools = (async () => {
      toolCalls += 1
      return { filteredTools: { glob: fakeTool("glob") } }
    }) as never
    const ctx = createMockCtx(directory, editor)

    const first = await resolveOmoRuntime(ctx as never, {} as never, deps)
    const second = await resolveOmoRuntime(ctx as never, {} as never, deps)

    expect(first).toBe(second)
    expect(getManagerCalls()).toBe(1)
    expect(toolCalls).toBe(1)
  })

  it("rebuilds the runtime when the context identity changes", async () => {
    const editor = createMockEditor()
    const { deps, getManagerCalls } = createFakeDeps({ glob: fakeTool("glob") })

    await resolveOmoRuntime(createMockCtx(directory, editor) as never, {} as never, deps)
    await resolveOmoRuntime(createMockCtx(directory, editor) as never, {} as never, deps)

    expect(getManagerCalls()).toBe(2)
  })
})

describe("withLocationTaskListId", () => {
  it("pins the task list to the session's project when the user set no id", () => {
    // given / when
    const config = withLocationTaskListId({} as never, "/home/user/projects/my-app")

    // then
    expect(config.sisyphus?.tasks?.task_list_id).toBe("my-app")
  })

  it("keeps an explicit task_list_id", () => {
    const config = { sisyphus: { tasks: { task_list_id: "chosen" } } }
    expect(withLocationTaskListId(config as never, "/work/other").sisyphus?.tasks?.task_list_id).toBe("chosen")
  })

  it("defers to the environment override", () => {
    const previous = process.env.ULTRAWORK_TASK_LIST_ID
    process.env.ULTRAWORK_TASK_LIST_ID = "from-env"
    try {
      expect(withLocationTaskListId({} as never, "/work/other").sisyphus?.tasks?.task_list_id).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ULTRAWORK_TASK_LIST_ID
      else process.env.ULTRAWORK_TASK_LIST_ID = previous
    }
  })

  it("leaves the config alone when the directory has no basename", () => {
    expect(withLocationTaskListId({} as never, "/").sisyphus).toBeUndefined()
  })
})
