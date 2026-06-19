/**
 * Minimal ANSI/SGR → styled-runs parser for the serial monitor's terminal view.
 *
 * Pure, dependency-free. Turns a line of text that may contain SGR color escapes
 * (ESC[31m …) into an array of {text, style} runs the monitor renders as
 * <span style={{fg,bg,...}}>. Style is CARRIED across lines by the caller (a
 * color set on one line persists until reset), so pass the previous line's `end`
 * style as the next line's `start`.
 *
 * Scope: SGR (color/attributes) only — 16/bright/256/truecolor + bold/dim/
 * italic/underline/reverse. Non-SGR CSI (cursor moves), OSC, and other control
 * bytes are STRIPPED (a pure SGR parser can't emulate cursor addressing; that
 * needs a full VT emulator which opentui lacks). Good for colored LOG output;
 * full-screen curses apps (vim/htop) are out of scope.
 */

export type Style = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  reverse?: boolean
}

export type Run = { text: string; style: Style }

const BASE16 = [
  "#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
]
const BRIGHT16 = [
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
]

function hex(n: number): string {
  return n.toString(16).padStart(2, "0")
}

// xterm 256-color palette → hex.
function xterm256(n: number): string {
  if (n < 8) return BASE16[n]!
  if (n < 16) return BRIGHT16[n - 8]!
  if (n < 232) {
    const c = n - 16
    const r = Math.floor(c / 36)
    const g = Math.floor((c % 36) / 6)
    const b = c % 6
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return `#${hex(v(r))}${hex(v(g))}${hex(v(b))}`
  }
  const g = 8 + (n - 232) * 10
  return `#${hex(g)}${hex(g)}${hex(g)}`
}

// Apply one SGR parameter list (the numbers between ESC[ and m) to a style.
function applySgr(style: Style, params: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) {
      // reset all
      s.fg = undefined
      s.bg = undefined
      s.bold = s.dim = s.italic = s.underline = s.reverse = false
    } else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.reverse = true
    else if (p === 22) s.bold = s.dim = false
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.reverse = false
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30]
    else if (p === 39) s.fg = undefined
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40]
    else if (p === 49) s.bg = undefined
    else if (p >= 90 && p <= 97) s.fg = BRIGHT16[p - 90]
    else if (p >= 100 && p <= 107) s.bg = BRIGHT16[p - 100]
    else if (p === 38 || p === 48) {
      // extended color: 38;5;n (256) or 38;2;r;g;b (truecolor)
      const mode = params[i + 1]
      if (mode === 5 && params[i + 2] !== undefined) {
        const col = xterm256(params[i + 2]!)
        if (p === 38) s.fg = col
        else s.bg = col
        i += 2
      } else if (mode === 2 && params[i + 4] !== undefined) {
        const col = `#${hex(params[i + 2]!)}${hex(params[i + 3]!)}${hex(params[i + 4]!)}`
        if (p === 38) s.fg = col
        else s.bg = col
        i += 4
      }
    }
  }
  return s
}

// Parse the CSI parameter string into numbers. Splits on BOTH ';' and ':' so
// the ITU/ISO colon form (38:5:n, 38:2:r:g:b) works alongside 38;5;n. Empty
// fields default to 0 (per spec); non-numeric params become -1 so applySgr
// IGNORES them instead of treating a garbled byte as a full reset (code 0).
function parseParams(params: string): number[] {
  if (params === "") return [0]
  return params.split(/[;:]/).map((x) => {
    if (x === "") return 0
    const n = parseInt(x, 10)
    return Number.isNaN(n) ? -1 : n
  })
}

const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  !!a.bold === !!b.bold &&
  !!a.dim === !!b.dim &&
  !!a.italic === !!b.italic &&
  !!a.underline === !!b.underline &&
  !!a.reverse === !!b.reverse

/**
 * Parse ONE line (must not contain \n) into styled runs, starting from `start`.
 * Returns the runs and the `end` style to carry to the next line. SGR escapes
 * are consumed; other CSI/OSC/control bytes are dropped.
 */
export function parseLine(line: string, start: Style): { runs: Run[]; end: Style } {
  const runs: Run[] = []
  let cur: Style = start
  let buf = ""
  const flush = () => {
    if (buf) {
      const last = runs[runs.length - 1]
      if (last && sameStyle(last.style, cur)) last.text += buf
      else runs.push({ text: buf, style: { ...cur } })
      buf = ""
    }
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    const code = ch.charCodeAt(0)
    // CSI: 7-bit ESC [ … or 8-bit C1 0x9b … (final byte @-~).
    const isCsi = (ch === "\x1b" && line[i + 1] === "[") || code === 0x9b
    // OSC: 7-bit ESC ] … or 8-bit C1 0x9d … (terminated by BEL or ST).
    const isOsc = (ch === "\x1b" && line[i + 1] === "]") || code === 0x9d
    if (isCsi) {
      let j = i + (ch === "\x1b" ? 2 : 1)
      let params = ""
      while (j < line.length && line[j]! >= " " && line[j]! <= "?") {
        params += line[j]
        j++
      }
      const final = line[j] // command byte
      if (final === "m") {
        flush()
        cur = applySgr(cur, parseParams(params))
      }
      // non-SGR CSI (cursor moves etc.) → dropped
      i = j // loop ++ moves past the final byte
      continue
    }
    if (isOsc) {
      let j = i + (ch === "\x1b" ? 2 : 1)
      while (j < line.length && line[j] !== "\x07" && line[j] !== "\x1b") j++
      if (line[j] === "\x1b" && line[j + 1] === "\\") i = j + 1 // proper ST
      else if (line[j] === "\x1b") i = j - 1 // inner ESC → reprocess as a new escape
      else i = j // BEL or end-of-line
      continue
    }
    if (ch === "\x1b") {
      i += 1 // other 2-byte escape → drop both
      continue
    }
    // drop stray control bytes (keep tab; lines are pre-split on \n) and any
    // remaining C1 controls 0x80-0x9f so no control byte ever lands in a run.
    if (code < 32 && ch !== "\t") continue
    if (code === 127) continue
    if (code >= 0x80 && code <= 0x9f) continue
    buf += ch
  }
  flush()
  return { runs, end: cur }
}
