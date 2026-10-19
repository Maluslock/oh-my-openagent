import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
// Type-only on purpose: OpenCode 2.x resolves this package at runtime for CLI plugins, but a 1.x
// host must not need it. `Plugin.define` is an identity helper in 2.0.11, so the definition object
// below is built directly under its type instead of importing the helper as a value.
import type { Plugin as CliPlugin } from "@opencode/plugin/tui"

import { registerBtwSideTui } from "./features/btw-side"
import { registerNativeEditionNudgeTui } from "./features/native-edition-nudge"
import { computeView, viewKey } from "./features/tui-sidebar/compute-view"
import { POLL_INTERVAL_MS } from "./features/tui-sidebar/constants"
import { deriveAgents, deriveConfig, deriveJobBoard, deriveLoop, deriveRoster } from "./features/tui-sidebar/derivers"
import type { ViewNode } from "./features/tui-sidebar/element-helpers"
import { readMirror } from "./features/tui-sidebar/mirror-io"
import { buildViewNodes } from "./features/tui-sidebar/render-view"
import type { RosterRow } from "./features/tui-sidebar/state-types"
import type { SidebarView } from "./features/tui-sidebar/state-types"
import { log } from "./shared/logger"
import { trackLoadedPluginSandbox } from "./hooks/auto-update-checker/checker/sandbox-refresh"

type SolidRuntime<Node> = {
  readonly createElement: (tag: string) => Node
  readonly insert: (parent: Node, child: Node | string) => unknown
  readonly setProp: (node: Node, name: string, value: unknown) => unknown
}

/** Same id for both host generations: 1.x reads `tui`, 2.x reads `setup`. */
const TUI_PLUGIN_ID = "oh-my-openagent:tui"

type SidebarSlotRegistration<Node> = {
  readonly order: number
  readonly slots: {
    readonly sidebar_content: () => Node | (() => Node)
  }
}

type RegisterSidebarContentSlotInput<Node> = {
  readonly registerSlot: (registration: SidebarSlotRegistration<Node>) => void
  readonly requestRender: () => void
  readonly renderSidebar: () => Node
}

export function registerSidebarContentSlot<Node>({
  registerSlot,
  requestRender,
  renderSidebar,
}: RegisterSidebarContentSlotInput<Node>): void {
  registerSlot({
    order: 900,
    slots: {
      sidebar_content: () => renderSidebar,
    },
  })
  requestRender()
}

function materialize<Node>(nodes: readonly ViewNode[], solid: SolidRuntime<Node>): Node {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root
}

function materializeNode<Node>(node: ViewNode, solid: SolidRuntime<Node>): Node {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props)) {
    solid.setProp(element, name, value)
  }
  if (node.kind === "text") {
    solid.insert(element, node.text ?? "")
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid))
  }
  return element
}

type RosterResolver = (directory: string) => RosterRow[]
type PluginValidation = {
  readonly valid: boolean
  readonly messages: readonly string[]
  readonly config: {
    readonly tui?: {
      readonly sidebar?: {
        readonly enabled?: boolean
      }
    }
  }
}

async function loadPluginValidation(directory: string): Promise<PluginValidation> {
  const { validatePluginConfig } = await import("./config/validate")
  return validatePluginConfig(directory)
}

async function loadRosterRows(directory: string): Promise<readonly RosterRow[]> {
  const { resolveRoster } = await import("./features/tui-sidebar/roster-resolver")
  const resolver: RosterResolver = resolveRoster
  return resolver(directory)
}

async function readView(directory: string): Promise<SidebarView> {
  const validation = await loadPluginValidation(directory)
  const mirror = readMirror(directory)
  const roster = await loadRosterRows(directory)
  return computeView({
    config: deriveConfig(validation),
    roster: deriveRoster(roster),
    agents: deriveAgents(mirror),
    jobs: deriveJobBoard(mirror),
    loop: deriveLoop(mirror),
  })
}

export function handleTuiPollError(
  error: unknown,
  reportPollError: (error: Error) => void = (pollError) => log("[tui-sidebar] polling failed", { error: pollError }),
): void {
  if (error instanceof Error) {
    reportPollError(error)
    return
  }
  throw error
}

type SidebarViewPolling = {
  readonly start: () => void
  readonly stop: () => void
}

/**
 * Shared sidebar poller. 1.x drives a manual re-render through `onViewChanged`; 2.x writes the view
 * into a reactive store instead, so the slot re-renders when it reads the new value.
 */
function createSidebarViewPolling(input: {
  readonly directory: string
  readonly initialView: SidebarView
  readonly onViewChanged: (view: SidebarView) => void
  readonly onError: (error: unknown) => void
}): SidebarViewPolling {
  let currentKey = viewKey(input.initialView)
  let disposed = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    timer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  const tick = async (): Promise<void> => {
    if (disposed || inFlight) {
      if (!disposed) schedule()
      return
    }
    inFlight = true
    try {
      const nextView = await readView(input.directory)
      const nextKey = viewKey(nextView)
      if (nextKey !== currentKey) {
        currentKey = nextKey
        input.onViewChanged(nextView)
      }
    } catch (error) {
      input.onError(error)
    } finally {
      inFlight = false
      if (!disposed) schedule()
    }
  }

  return {
    start: schedule,
    stop: () => {
      disposed = true
      if (timer) clearTimeout(timer)
    },
  }
}

const v1Module: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui: async (api) => {
    // The TUI plugin runs on OpenCode's main thread, the only thread that
    // emits `exit`; it applies a sandbox refresh the server plugin requested.
    trackLoadedPluginSandbox()

    const solid = await import("@opentui/solid").catch(() => null)
    if (!solid) {
      return
    }

    try {
      await registerBtwSideTui(api, solid)
    } catch (error) {
      log("[btw-side] TUI registration failed", { error })
    }

    try {
      registerNativeEditionNudgeTui(api as never)
    } catch (error) {
      log("[native-edition-nudge] TUI registration failed", { error })
    }

    const directory = api.state.path.directory
    if ((await loadPluginValidation(directory)).config.tui?.sidebar?.enabled === false) {
      return
    }

    let currentView = await readView(directory)

    registerSidebarContentSlot({
      registerSlot: (registration) => {
        api.slots.register(registration)
      },
      requestRender: () => {
        api.renderer.requestRender()
      },
      renderSidebar: () => materialize(buildViewNodes(currentView, api.theme.current), solid),
    })

    const polling = createSidebarViewPolling({
      directory,
      initialView: currentView,
      onViewChanged: (nextView) => {
        currentView = nextView
        api.renderer.requestRender()
      },
      onError: handleTuiPollError,
    })

    polling.start()
    api.lifecycle.onDispose(polling.stop)
  },
}

/**
 * OpenCode 2.x CLI plugin definition: the same sidebar on the `sidebar.content` slot.
 *
 * `context.storage.memory` is the reactive source, so the poller no longer requests a render itself.
 */
function createV2TuiDefinition(): CliPlugin.Definition {
  return {
    id: TUI_PLUGIN_ID,
    async setup(context) {
      const solid = await import("@opentui/solid").catch(() => null)
      if (!solid) {
        return
      }

      const directory = context.location?.directory ?? context.data.location.default().directory
      if ((await loadPluginValidation(directory)).config.tui?.sidebar?.enabled === false) {
        return
      }

      const [sidebarState, updateSidebarState] = context.storage.memory("sidebar-view", {
        initial: { view: await readView(directory) },
      })

      // `@opentui/solid`'s imperative node construction produces the node type JSX compiles to;
      // 2.x types slot render as JSX, so the cast is the typing equivalent of returning JSX.
      const claim = {
        append: "sidebar.content",
        render: () => materialize(buildViewNodes(sidebarState.view, context.theme), solid),
      } as unknown as Parameters<CliPlugin.Context["ui"]["slot"]>[0]
      const releaseSlot = context.ui.slot(claim)

      const polling = createSidebarViewPolling({
        directory,
        initialView: sidebarState.view,
        onViewChanged: (nextView) => {
          updateSidebarState((draft) => {
            draft.view = nextView
          })
        },
        onError: handleTuiPollError,
      })

      polling.start()
      return () => {
        polling.stop()
        releaseSlot()
      }
    },
  }
}

export default { ...v1Module, ...createV2TuiDefinition() }
