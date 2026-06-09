/**
 * Vendored minimal type surface for the opencode plugin host.
 *
 * These declarations mirror the contract of the opencode fork's
 * `packages/plugin/src` — Plugin, PluginInput, Hooks (including the
 * `experimental.chat.system.transform` hook the exp relies on for
 * incremental system-prompt injection) plus the `tool()` helper.
 *
 * The plugin is loaded BY opencode at runtime, which supplies the real
 * implementations; we only need these types at dev time. SDK payload shapes
 * (Event, Message, Part, …) are intentionally loosened to the minimum the
 * plugin reads — tighten them per feature as the wiring needs more.
 *
 * Keeping this vendored (rather than depending on @opencode-ai/plugin from a
 * private fork registry) is what makes this project standalone.
 */

import { z } from "zod"

// -----------------------------------------------------------------------------
// Loosened SDK payload shapes
// -----------------------------------------------------------------------------

export type Event = { type: string; properties?: Record<string, any> }

export type TextPart = { type: "text"; text: string; synthetic?: boolean; ignored?: boolean; [k: string]: any }
export type ToolPart = { type: "tool"; tool: string; [k: string]: any }
export type Part = TextPart | ToolPart | { type: string; [k: string]: any }

export type UserMessage = {
  id: string
  role: "user"
  sessionID?: string
  time?: { created: number; completed?: number }
  [k: string]: any
}

export type Message = {
  id: string
  role: "user" | "assistant" | string
  sessionID?: string
  time?: { created: number; completed?: number }
  [k: string]: any
}

export type Model = { id?: string; modelID?: string; providerID?: string; [k: string]: any }
export type Permission = { [k: string]: any }

/**
 * Minimal opencode SDK client surface. Only the endpoints the plugin actually
 * calls are typed; everything else is reachable via the index signature.
 * Extend the explicit methods as features need stronger typing.
 */
export type SessionInfo = { id: string; parentID?: string; [k: string]: any }

export interface OpencodeClient {
  session: {
    // Real opencode SDK shape: ({ sessionID }, { throwOnError? }) -> { data?: SessionInfo }
    get(
      input: { sessionID: string },
      opts?: { throwOnError?: boolean },
    ): Promise<{ data?: SessionInfo } & Record<string, any>>
    // ({ sessionID, limit?, before? }) -> { data?: [{ info, parts }] }
    messages(input: {
      sessionID: string
      limit?: number
      before?: string
    }): Promise<{ data?: Array<{ info: Message; parts: Part[] }> } & Record<string, any>>
    [k: string]: any
  }
  [k: string]: any
}

// -----------------------------------------------------------------------------
// Plugin contract
// -----------------------------------------------------------------------------

export type PluginInput = {
  client: OpencodeClient
  project: { id: string; worktree?: string; [k: string]: any }
  directory: string
  worktree: string
  serverUrl: URL
  $: any
  experimental_workspace: { register(type: string, adaptor: any): void }
}

export type PluginOptions = Record<string, unknown>

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

// -----------------------------------------------------------------------------
// Tool helper (runtime — ported from packages/plugin/src/tool.ts)
// -----------------------------------------------------------------------------

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, any> }): void
}

export type ToolResult = string | { output: string; metadata?: Record<string, any> }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: any) => Promise<void>
  tool?: { [key: string]: ToolDefinition }

  /** Fired when a new user message is received (read-only). */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>

  "chat.params"?: (input: any, output: any) => Promise<void>

  /** Modify the system prompt before the LLM call (system-role injection). */
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: { system: string[] },
  ) => Promise<void>

  /** Transform the whole message list before the LLM call. */
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: { messages: { info: Message; parts: Part[] }[] },
  ) => Promise<void>

  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>

  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => Promise<void>

  // Other hooks (permission.ask, command.*, etc.) are reachable but untyped here.
  [k: string]: any
}
