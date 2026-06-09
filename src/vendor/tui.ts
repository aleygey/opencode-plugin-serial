/**
 * Vendored minimal TUI plugin surface for opencode's @opentui-based TUI.
 *
 * Mirrors the host's `packages/plugin/src/tui.ts` contract, loosened to just
 * what the serial monitor uses. opencode supplies the real implementation at
 * runtime; these types are dev-time only. Kept vendored (rather than depending
 * on @opencode-ai/plugin from a private fork) so the project stays standalone.
 */

import type { JSX } from "@opentui/solid"

export type TuiThemeColors = Record<string, any>
export type TuiTheme = { readonly current: TuiThemeColors }

export type TuiRouteDefinition = {
  name: string
  render: (input: { params?: Record<string, unknown> }) => JSX.Element
}

export type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  slash?: { name: string; aliases?: string[] }
  onSelect?: () => void
  [k: string]: any
}

export type TuiSlotPlugin = {
  order?: number
  slots: Record<string, (...args: any[]) => JSX.Element | null>
}

export type TuiPluginApi = {
  theme: TuiTheme
  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: { name: string; [k: string]: any }
  }
  command: { register: (cb: () => TuiCommand[]) => () => void; [k: string]: any }
  slots: { register: (plugin: TuiSlotPlugin) => string }
  event?: { on: (type: string, handler: (event: any) => void) => () => void }
  client?: any
  lifecycle?: { readonly signal: AbortSignal; onDispose: (fn: () => void) => () => void }
  [k: string]: any
}

export type TuiPlugin = (api: TuiPluginApi, options?: Record<string, unknown>, meta?: any) => Promise<void>

export type TuiPluginModule = { id?: string; tui: TuiPlugin }
