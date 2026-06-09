import { z } from "zod"
import { randomBytes } from "node:crypto"

/**
 * SerialID — self-contained ascending id.
 *
 * Replaces the core `@/id` Identifier so the package has no opencode-internal
 * dependency. The only contract the Serial service relies on is that ids sort
 * chronologically (ascending), which a time-prefixed id satisfies.
 */

const PREFIX = "serial"

export type SerialID = string & { readonly __serialId: unique symbol }

let lastTime = 0
let counter = 0

export function ascending(): SerialID {
  const now = Date.now()
  if (now <= lastTime) {
    counter += 1
  } else {
    lastTime = now
    counter = 0
  }
  const time = lastTime.toString(36).padStart(10, "0")
  const seq = counter.toString(36).padStart(3, "0")
  const rand = randomBytes(5).toString("hex")
  return `${PREFIX}_${time}${seq}${rand}` as SerialID
}

// zod's .refine() doesn't narrow the output type, so cast to a ZodType that
// produces the SerialID brand — this makes `.parse()` return SerialID and the
// Info schema's `id` field infer as SerialID rather than plain string.
const zod = z
  .string()
  .refine((v): v is SerialID => v.startsWith(`${PREFIX}_`), { message: "invalid SerialID" }) as unknown as z.ZodType<SerialID>

export const SerialID = {
  ascending,
  zod,
}
