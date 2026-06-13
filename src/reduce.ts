/**
 * Display-only log de-noising reducer.
 *
 * Applied to the TEXT returned by Serial.snapshot()/collect() AFTER all cursor
 * math is computed. The raw 2MB ring buffer (session.buffer), session.cursor,
 * session.bufferCursor, and the WebSocket replay are NEVER touched, so every
 * cursor the caller sees still reflects RAW byte positions. This module only
 * rewrites the human-facing string.
 *
 * Pipeline (each stage optional via flags):
 *   split -> classify(progress) -> exclude/include filter -> normalize(shape
 *   keys) -> cyclic-block collapse -> consecutive-dup fold -> render
 *
 * Bounded cost: input is capped at MAX_LINES lines (tail kept); cyclic scan is
 * capped at maxPeriod. Worst case O(N * maxPeriod). Deterministic.
 */

export type ReduceOptions = {
  /** Fold consecutive identical (or same-shape) lines: A A A -> "A   (x3)". */
  dedup?: boolean
  /** Detect & collapse cyclic multi-line blocks: A B C A B C -> block + (x3). */
  cycles?: boolean
  /** Normalize volatile tokens (timestamps, counters, hex, MAC/IP) to a shape key. */
  normalize?: boolean
  /** Drop lines whose RAW text matches any of these regex sources. */
  exclude?: string[]
  /** Keep ONLY lines whose RAW text matches any of these regex sources (applied before exclude). */
  include?: string[]
  /** Max repeating-block period to scan for (lines). Default 32, hard-capped at MAX_PERIOD. */
  maxPeriod?: number
  /** Minimum repeats before a run is collapsed. Default 2 (i.e. "(x2)"+). Min 2. */
  minRepeats?: number
  /** Hard cap on input lines actually processed (tail kept). Default 20000. */
  maxLines?: number
  /** Show value range for normalized folds, e.g. "(x3, [12.3..12.9])". Default false. */
  showRange?: boolean
}

const MAX_PERIOD = 64
const DEFAULT_MAX_PERIOD = 32
const DEFAULT_MAX_LINES = 20000

// ── Volatile-token normalizer ───────────────────────────────────────────────
// Order matters: most specific first so e.g. a MAC isn't half-eaten by the hex
// rule. Each replacement collapses a volatile token to a fixed canonical glyph
// so that lines differing only in those tokens hash to the same shape key.
type NormRule = { re: RegExp; canon: string; capture: boolean }
const NORM_RULES: NormRule[] = [
  // kernel/printk timestamp: [   12.345678] or [12.345]
  { re: /\[\s*\d+\.\d+\]/g, canon: "[..]", capture: true },
  // ISO-ish / clock timestamps 12:34:56(.789)
  { re: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, canon: "<time>", capture: true },
  // MAC address
  { re: /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g, canon: "<mac>", capture: true },
  // IPv4 (optionally :port)
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, canon: "<ip>", capture: true },
  // hex addresses / values 0xDEADBEEF
  { re: /\b0x[0-9a-fA-F]+\b/g, canon: "<hex>", capture: true },
  // bare longish hex blobs (>=4 hex chars, not pure decimal) e.g. ffff8800
  { re: /\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{4,}\b/g, canon: "<hex>", capture: true },
  // standalone integers (counters, byte offsets, sizes)
  { re: /\b\d+\b/g, canon: "<n>", capture: true },
]

// Spinner / CR-progress detection. A physical line that contained \r overwrites
// (e.g. "10%\r20%\r30%") is reduced by snapshot's CR-flatten to its last frame;
// these patterns catch the common residual progress shapes.
const SPINNER_RE = /^[\s|/\-\\]*$|[▏▎▍▌▋▊▉█░▒▓]|^\s*\d{1,3}%/

function compile(srcs: string[] | undefined): RegExp[] {
  if (!srcs || srcs.length === 0) return []
  const out: RegExp[] = []
  for (const s of srcs) {
    try {
      out.push(new RegExp(s))
    } catch {
      /* skip invalid pattern, display-only path must never throw */
    }
  }
  return out
}

/**
 * Flatten carriage-return overwrites WITHIN a physical line. "a\rb\rc" means the
 * terminal showed "a", then overwrote with "b", then "c"; the visible result is
 * the last segment, with shorter overwrites letting tail chars of the previous
 * frame show through (classic terminal behavior). We keep it simple+deterministic:
 * take the last \r-segment but pad with the longest-seen suffix so a spinner that
 * shrinks ("Done.   " over "Working...") still reads cleanly.
 */
function flattenCR(line: string): string {
  if (line.indexOf("\r") < 0) return line
  const segs = line.split("\r")
  let result = ""
  for (const seg of segs) {
    if (seg.length >= result.length) result = seg
    else result = seg + result.slice(seg.length)
  }
  return result
}

type Norm = { key: string; volatile: boolean; rawSample: string }

function normalizeLine(line: string, enabled: boolean): Norm {
  if (!enabled) return { key: line, volatile: false, rawSample: line }
  let key = line
  let volatile = false
  for (const rule of NORM_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(key)) {
      volatile = true
      rule.re.lastIndex = 0
      key = key.replace(rule.re, rule.canon)
    }
  }
  return { key, volatile, rawSample: line }
}

// ── Cyclic-block detection ──────────────────────────────────────────────────
// Greedy maximal-run collapse over the array of shape KEYS.
//
// At position i we find the SMALLEST period p in [1..maxPeriod] such that the
// block keys[i..i+p) repeats at least `minRepeats` times contiguously, then we
// take the MAXIMAL number of whole repeats (rolling equality, no re-hash), emit
// the block once with its repeat count + trailing partial cycle, and advance.
//
// Smallest-period-first guarantees A B C A B C is reported as period 3 (x2),
// never as period 6 (x1). p=1 naturally handles consecutive-identical folding,
// so `dedup` is just `cycles` restricted to p===1 when cycles is off.
//
// Complexity: each i tries up to maxPeriod candidate periods, each verified by a
// linear walk that consumes the run it proves; amortized O(N * maxPeriod).

function periodMatches(keys: string[], i: number, p: number): number {
  // Returns the number of WHOLE repeats of keys[i..i+p) starting at i (>=1),
  // requiring at least 2 to count as a cycle. Rolling element compare.
  const n = keys.length
  if (i + p > n) return 0
  let reps = 1
  let j = i + p
  while (j + p <= n) {
    let eq = true
    for (let k = 0; k < p; k++) {
      if (keys[j + k] !== keys[i + k]) {
        eq = false
        break
      }
    }
    if (!eq) break
    reps++
    j += p
  }
  return reps
}

function isPrimitivePeriod(keys: string[], i: number, p: number): boolean {
  // Reject p if the block keys[i..i+p) is itself k copies of a smaller period
  // (so "A A A A" with p=2 is rejected in favor of p=1 found earlier; this guard
  // is only needed when a larger p is tested before a divisor — it isn't here
  // because we scan p ascending — but kept for safety/determinism).
  for (let q = 1; q < p; q++) {
    if (p % q !== 0) continue
    let allEq = true
    for (let k = q; k < p; k++) {
      if (keys[i + k] !== keys[i + (k % q)]) {
        allEq = false
        break
      }
    }
    if (allEq) return false
  }
  return true
}

type Segment =
  | { kind: "line"; text: string }
  | { kind: "fold"; sample: string; count: number; volatile: boolean; range?: [string, string] }
  | { kind: "cycle"; block: string[]; count: number; partial: number }

function collapse(
  rawLines: string[],
  keys: string[],
  norms: Norm[],
  opts: Required<Pick<ReduceOptions, "cycles" | "dedup" | "minRepeats" | "maxPeriod" | "showRange">>,
): Segment[] {
  const out: Segment[] = []
  const n = keys.length
  const cap = Math.min(opts.maxPeriod, MAX_PERIOD)
  const minRep = Math.max(2, opts.minRepeats)
  let i = 0
  while (i < n) {
    let bestP = 0
    let bestReps = 0
    const maxP = opts.cycles ? cap : 1 // dedup-only => only p=1
    for (let p = 1; p <= maxP && i + p * minRep <= n; p++) {
      if (!isPrimitivePeriod(keys, i, p)) continue
      const reps = periodMatches(keys, i, p)
      if (reps >= minRep) {
        bestP = p
        bestReps = reps
        break // smallest period wins
      }
    }
    if (bestP === 0) {
      // parallel arrays (rawLines/keys/norms share length); i < n is loop-guarded
      out.push({ kind: "line", text: rawLines[i]! })
      i++
      continue
    }
    const consumed = bestP * bestReps
    // trailing partial cycle: how many leading keys of the next slot still match
    let partial = 0
    const after = i + consumed
    while (partial < bestP && after + partial < n && keys[after + partial] === keys[i + partial]) {
      partial++
    }
    if (bestP === 1) {
      const norm = norms[i]!
      const seg: Extract<Segment, { kind: "fold" }> = {
        kind: "fold",
        sample: rawLines[i]!,
        count: bestReps,
        volatile: norm.volatile,
      }
      if (opts.showRange && norm.volatile) {
        seg.range = [rawLines[i]!, rawLines[i + consumed - 1]!]
      }
      out.push(seg)
    } else {
      out.push({ kind: "cycle", block: rawLines.slice(i, i + bestP), count: bestReps, partial })
    }
    i += consumed + partial
  }
  return out
}

function render(segs: Segment[]): string[] {
  const lines: string[] = []
  for (const seg of segs) {
    if (seg.kind === "line") {
      lines.push(seg.text)
    } else if (seg.kind === "fold") {
      const range = seg.range ? `, [${seg.range[0]} .. ${seg.range[1]}]` : ""
      lines.push(`${seg.sample}   (x${seg.count}${range})`)
    } else {
      // cycle
      lines.push(`┌─ repeating block ×${seg.count}${seg.partial ? ` (+${seg.partial} partial)` : ""}`)
      for (const b of seg.block) lines.push(`│ ${b}`)
      lines.push("└─")
    }
  }
  return lines
}

/**
 * Reduce noisy serial text to a compact display string. Pure, never throws.
 * Preserves a trailing newline iff the input had one (so callers that append
 * cursors/metadata keep their layout).
 */
export function reduceLines(text: string, opts: ReduceOptions = {}): string {
  if (!text) return text
  const dedup = opts.dedup ?? true
  const cycles = opts.cycles ?? true
  const normalize = opts.normalize ?? true
  const showRange = opts.showRange ?? false
  const maxPeriod = Math.min(opts.maxPeriod ?? DEFAULT_MAX_PERIOD, MAX_PERIOD)
  const minRepeats = Math.max(2, opts.minRepeats ?? 2)
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES

  if (!dedup && !cycles && !normalize && !opts.exclude && !opts.include) return text

  // A device that uses lone \r as its line break has no \n at all; treat \r as
  // the newline so its real lines aren't fed to flattenCR below (which would
  // collapse them as carriage-return OVERWRITES and eat the output). Operates on
  // this display copy only — the raw ring buffer upstream is untouched.
  const work = !text.includes("\n") && text.includes("\r") ? text.replace(/\r/g, "\n") : text
  const hadTrailingNL = /\r?\n$/.test(work)
  // Split on LF, tolerate CRLF; keep a trailing \r on the last partial line out
  // of the split so an in-flight line isn't mangled.
  const rawSplit = work.split("\n")
  if (hadTrailingNL) rawSplit.pop() // drop empty tail produced by trailing \n
  let rawLines = rawSplit.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))

  // Bounded input: keep the TAIL (most recent) lines.
  if (rawLines.length > maxLines) rawLines = rawLines.slice(rawLines.length - maxLines)

  // CR-overwrite flatten within each physical line.
  rawLines = rawLines.map(flattenCR)

  // include/exclude filtering on RAW text (include wins-first, then exclude).
  const incRe = compile(opts.include)
  const excRe = compile(opts.exclude)
  if (incRe.length) rawLines = rawLines.filter((l) => incRe.some((r) => r.test(l)))
  if (excRe.length) rawLines = rawLines.filter((l) => !excRe.some((r) => r.test(l)))

  if (rawLines.length === 0) return hadTrailingNL ? "" : ""

  // Normalize -> shape keys. Spinner lines fold under a single shape key so a
  // burst of progress frames collapses even when their text differs.
  const norms: Norm[] = rawLines.map((l) => {
    if (SPINNER_RE.test(l)) return { key: " spinner", volatile: true, rawSample: l }
    return normalizeLine(l, normalize)
  })
  const keys = norms.map((nm) => nm.key)

  const segs = collapse(rawLines, keys, norms, {
    cycles,
    dedup,
    minRepeats,
    maxPeriod,
    showRange,
  })

  const outLines = render(segs)
  const joined = outLines.join("\n")
  return hadTrailingNL ? joined + "\n" : joined
}
