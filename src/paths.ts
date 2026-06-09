import path from "node:path"

export type ServerPaths = { worktree?: string; directory?: string }

// Self-contained, not tied to the in-core refiner-memory layout.
const DEFAULT_DIR = ".opencode/serial"

export function baseDir(cfg: ServerPaths): string {
  const root = cfg.directory || cfg.worktree || process.cwd()
  return path.join(root, DEFAULT_DIR)
}

/** Discovery file the /serial server writes so a TUI/web monitor can find it. */
export const apiInfoFile = (base: string) => path.join(base, "api.json")
