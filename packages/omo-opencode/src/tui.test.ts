/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

import tuiModule, { handleTuiPollError, registerSidebarContentSlot } from "./tui"

type SolidNode = {
  readonly tag: string
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

type SidebarApiForTest = {
  readonly state: {
    readonly path: {
      readonly directory: string
    }
    readonly session: {
      readonly get: () => undefined
      readonly messages: () => []
      readonly status: () => { readonly type: "idle" }
      readonly permission: () => []
      readonly question: () => []
    }
  }
  readonly theme: {
    readonly current: Record<string, unknown>
  }
  readonly slots: {
    readonly register: (registration: TuiSlotPlugin) => string
  }
  readonly client: {
    readonly session: {
      readonly list: () => Promise<{ readonly data: [] }>
      readonly create: () => Promise<{ readonly data: undefined }>
      readonly abort: () => Promise<{ readonly data: true }>
      readonly delete: () => Promise<{ readonly data: true }>
    }
  }
  readonly keymap: {
    readonly registerLayer: () => () => void
  }
  readonly mode: {
    readonly current: () => string
  }
  readonly route: {
    readonly current: {
      readonly name: "home"
    }
    readonly navigate: () => void
  }
  readonly event: {
    readonly on: () => () => void
  }
  readonly ui: {
    readonly Prompt: () => undefined
    readonly Slot: () => undefined
    readonly toast: () => void
  }
  readonly renderer: {
    readonly requestRender: () => void
  }
  readonly lifecycle: {
    readonly signal: AbortSignal
    readonly onDispose: (dispose: () => void) => () => void
  }
}

describe("TUI sidebar polling", () => {
  let tempDir = ""

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-tui-test-"))
  })

  afterEach(() => {
    mock.restore()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("#given the TUI plugin starts #when it registers the sidebar slot #then an initial render is requested immediately", async () => {
    // given
    const calls: string[] = []
    const disposers: (() => void)[] = []
    let registration: TuiSlotPlugin | undefined

    mock.module("@opentui/solid", () => ({
      createElement: (tag: string): SolidNode => ({ tag, props: {}, children: [] }),
      insert: (parent: SolidNode, child: unknown): void => {
        parent.children.push(child)
      },
      setProp: (node: SolidNode, name: string, value: unknown): void => {
        node.props[name] = value
      },
    }))

    const api = {
      state: {
        path: { directory: tempDir },
        session: {
          get: () => undefined,
          messages: () => [],
          status: () => ({ type: "idle" as const }),
          permission: () => [],
          question: () => [],
        },
      },
      theme: { current: {} },
      slots: {
        register: (nextRegistration: TuiSlotPlugin): string => {
          calls.push("register")
          registration = nextRegistration
          return "omo-sidebar-slot"
        },
      },
      client: {
        session: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: undefined }),
          abort: async () => ({ data: true as const }),
          delete: async () => ({ data: true as const }),
        },
      },
      keymap: {
        registerLayer: (): (() => void) => () => undefined,
      },
      mode: {
        current: () => "base",
      },
      route: {
        current: { name: "home" as const },
        navigate: () => undefined,
      },
      event: {
        on: (): (() => void) => () => undefined,
      },
      ui: {
        Prompt: () => undefined,
        Slot: () => undefined,
        toast: () => undefined,
      },
      renderer: {
        requestRender: (): void => {
          calls.push("render")
        },
      },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: (dispose: () => void): (() => void) => {
          disposers.push(dispose)
          return () => undefined
        },
      },
    } satisfies SidebarApiForTest

    // when
    await tuiModule.tui(api as unknown as TuiPluginApi, undefined, {} as TuiPluginMeta)

    // then
    expect(calls).toEqual(["register", "register", "render"])
    expect(registration).toBeDefined()
    if (!registration) {
      throw new Error("sidebar slot was not registered")
    }
    expect(registration.order).toBe(900)
    expect(Object.keys(registration.slots)).toEqual(["sidebar_content"])
    expect(registration.slots.sidebar_content).toBeFunction()
    for (const dispose of disposers) dispose()
  })

  it("#given sidebar state changes after the slot mounts #when the host renders again #then the sidebar output is current", () => {
    // given
    let state = "initial"
    let registration: TuiSlotPlugin | undefined
    let mountedOutput: unknown
    let renderedOutput: unknown
    let requestRender = (): void => undefined
    registerSidebarContentSlot({
      registerSlot: (nextRegistration) => {
        registration = nextRegistration as TuiSlotPlugin
      },
      requestRender: () => {
        requestRender = () => {
          if (typeof mountedOutput === "function") {
            renderedOutput = (mountedOutput as () => string)()
          }
        }
      },
      renderSidebar: () => state,
    })

    // when
    if (!registration) throw new Error("sidebar slot was not registered")
    mountedOutput = registration.slots.sidebar_content()
    const initialOutput = (mountedOutput as () => string)()
    state = "updated"
    // requestRender is the host's signal; Solid re-evaluates the returned child accessor.
    renderedOutput = undefined
    requestRender()

    // then
    expect(initialOutput).toBe("initial")
    expect(renderedOutput).toBe("updated")
  })

  it("#given an unexpected Error during polling #when the poll error handler runs #then the error is logged", () => {
    // given
    const pollError = new TypeError("view derivation failed")
    const reportedErrors: Error[] = []

    // when
    handleTuiPollError(pollError, (error) => {
      reportedErrors.push(error)
    })

    // then
    expect(reportedErrors).toEqual([pollError])
  })

  it("#given a non-Error throw during polling #when the poll error handler runs #then the value is rethrown", () => {
    // given
    const thrownValue = "bad poll state"

    expect(() => handleTuiPollError(thrownValue)).toThrow(thrownValue)
  })
})

describe("TUI sidebar on the OpenCode 2.x CLI plugin API", () => {
  let tempDir = ""
  let envSnapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Config discovery is env-driven, so isolate it instead of inheriting whatever config state a
    // previously-run suite left behind (which would decide whether `setup` proceeds).
    envSnapshot = {}
    for (const key of ["HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
      envSnapshot[key] = process.env[key]
    }
    tempDir = mkdtempSync(join(tmpdir(), "omo-tui-v2-test-"))
    process.env.HOME = tempDir
    process.env.OPENCODE_CONFIG_DIR = join(tempDir, "config")
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-config")
    mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })
    mkdirSync(join(tempDir, ".omo"), { recursive: true })
    mock.module("@opentui/solid", () => ({
      createElement: (tag: string): SolidNode => ({ tag, props: {}, children: [] }),
      insert: (parent: SolidNode, child: unknown): void => {
        parent.children.push(child)
      },
      setProp: (node: SolidNode, name: string, value: unknown): void => {
        node.props[name] = value
      },
    }))
  })

  afterEach(() => {
    mock.restore()
    rmSync(tempDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("#given one module for both hosts #when the default export is read #then it carries the 1.x and 2.x entrypoints", () => {
    // given / when / then
    expect(tuiModule.id).toBe("oh-my-openagent:tui")
    expect(tuiModule.tui).toBeFunction()
    expect(tuiModule.setup).toBeFunction()
  })

  it("#given the 2.x setup runs #when it registers the sidebar #then it claims sidebar.content and its cleanup releases everything", async () => {
    // given a fake 2.x context whose storage.memory is a plain store
    const claims: Array<{ append?: string; render: () => unknown }> = []
    let releasedSlots = 0
    let store: { view: unknown } | undefined
    const context = {
      location: { directory: tempDir },
      theme: {},
      ui: {
        slot: (claim: { append?: string; render: () => unknown }): (() => void) => {
          claims.push(claim)
          return () => {
            releasedSlots += 1
          }
        },
      },
      storage: {
        memory: (_key: string, options: { initial: { view: unknown } }) => {
          store = options.initial
          return [store, (mutation: (draft: { view: unknown }) => void) => mutation(store!)] as const
        },
      },
      data: { location: { default: () => ({ directory: tempDir }) } },
    }

    // when
    const cleanup = await tuiModule.setup(context as unknown as Parameters<typeof tuiModule.setup>[0])

    // then the slot is claimed with append placement and a render function
    expect(claims).toHaveLength(1)
    expect(claims[0]?.append).toBe("sidebar.content")
    expect(claims[0]?.render).toBeFunction()
    expect((claims[0]?.render() as SolidNode | undefined)?.tag).toBe("box")

    // and the returned cleanup stops whoever owns the subscription
    expect(cleanup).toBeFunction()
    cleanup?.()
    expect(releasedSlots).toBe(1)
  })

  it("#given the sidebar is disabled in config #when the 2.x setup runs #then it claims no slot", async () => {
    // given a real config file that turns the sidebar off (no shared-module mocking: that leaks
    // into every other suite that reads config)
    writeFileSync(
      join(tempDir, ".omo", "omo.jsonc"),
      JSON.stringify({ "[opencode]": { tui: { sidebar: { enabled: false } } } }),
      "utf-8",
    )
    const claims: unknown[] = []
    const context = {
      location: { directory: tempDir },
      theme: {},
      ui: {
        slot: (claim: unknown): (() => void) => {
          claims.push(claim)
          return () => undefined
        },
      },
      storage: { memory: () => [{ view: {} }, () => undefined] as const },
      data: { location: { default: () => ({ directory: tempDir }) } },
    }

    // when
    const cleanup = await tuiModule.setup(context as unknown as Parameters<typeof tuiModule.setup>[0])

    // then
    expect(claims).toEqual([])
    expect(cleanup).toBeUndefined()
  })
})
