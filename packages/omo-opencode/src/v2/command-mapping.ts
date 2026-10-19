// packages/omo-opencode/src/v2/command-mapping.ts
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition as V1CommandDefinition } from "../features/claude-code-command-loader"

/**
 * V1 -> V2 slash-command mapping.
 *
 * V1 contributed commands by writing templates into the host config, and the host expanded them.
 * V2's `ctx.command.transform` editor only accepts `{ name, description?, execute }`: the plugin
 * owns expansion and delivery. The live contract (probed against opencode 2.0.11) is that `execute`
 * receives `{ sessionID, prompt, delivery }` and the plugin posts the prompt itself through
 * `ctx.session.prompt`, optionally after `ctx.session.switchAgent`.
 *
 * The host expanded three placeholders, and so does this module: `$ARGUMENTS`, `$SESSION_ID`,
 * `$TIMESTAMP`. (`$BASE_BRANCH` in the remove-ai-slops template is a shell variable inside a bash
 * snippet, not a placeholder.) V1 fields with no V2 equivalent - `argumentHint`, `model`, `subtask`,
 * `handoffs` - are dropped rather than smuggled in as unknown keys.
 */

type V2Setup = NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>
type V2Context = Parameters<V2Setup>[0]
// `transform` is a callable taking the editor callback, so unwrap two levels to reach the editor.
type V2CommandTransform = NonNullable<V2Context["command"]>["transform"]
type V2CommandEditor = Parameters<Parameters<V2CommandTransform>[0]>[0]

export type V2CommandDefinition = Parameters<V2CommandEditor["add"]>[0]
export type V2CommandInvocation = Parameters<V2CommandDefinition["execute"]>[0]

export type CommandTemplateVariables = {
  readonly arguments: string
  readonly sessionID: string
  readonly timestamp: string
}

/**
 * Expand the placeholders the V1 host expanded.
 *
 * `$ARGUMENTS` is substituted last on purpose: it carries raw user text, and expanding it first
 * would let a user who types a literal `$SESSION_ID` make the session leak into their own argument
 * text.
 */
export function expandCommandTemplate(template: string, variables: CommandTemplateVariables): string {
  return template
    .replaceAll("$SESSION_ID", variables.sessionID)
    .replaceAll("$TIMESTAMP", variables.timestamp)
    .replaceAll("$ARGUMENTS", variables.arguments)
}

export type CommandDeliveryInput = {
  readonly invocation: V2CommandInvocation
  readonly command: V1CommandDefinition
  readonly text: string
}

/** Delivers one already-expanded command prompt. Injected so this module stays host-agnostic. */
export type CommandDeliver = (input: CommandDeliveryInput) => Promise<void>

/**
 * Map V1 built-in commands onto V2 definitions.
 *
 * `now` is injected so the expanded `$TIMESTAMP` is deterministic under test.
 */
export function toV2CommandDefinitions(
  commands: Record<string, V1CommandDefinition>,
  deliver: CommandDeliver,
  now: () => Date = () => new Date(),
): V2CommandDefinition[] {
  const definitions: V2CommandDefinition[] = []

  for (const [name, command] of Object.entries(commands)) {
    if (typeof command?.template !== "string" || command.template.length === 0) continue

    const definition: { name: string; execute: V2CommandDefinition["execute"]; description?: string } = {
      name,
      execute: async (invocation) => {
        const text = expandCommandTemplate(command.template, {
          arguments: invocation.prompt.text,
          sessionID: invocation.sessionID,
          timestamp: now().toISOString(),
        })
        await deliver({ invocation, command, text })
      },
    }
    // The host declares `description` with `optionalKey`, which accepts an absent key but not an
    // explicit `undefined` value, so only write it when there is one.
    if (typeof command.description === "string" && command.description.length > 0) {
      definition.description = command.description
    }
    definitions.push(definition)
  }

  return definitions
}
