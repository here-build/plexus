import type * as Y from "yjs";

import { refByUuid } from "./internal.js";
import type { EntityRef } from "./types.js";

/*
 * The ref-level twin of Plexus's `deserializeKey` (plexus/packages/plexus/src/proxies/key-serialization.ts).
 *
 * A `@syncing.child.map` / `.child.set` stores its key in the child's `\0` tuple[2] as a SERIALIZED
 * string — `serializeKey`'s output: `"<Prefix>\n<line>\n<line>…"`, Prefix ∈ {Set, Array, Value}, each
 * line the JSON of an entity REFERENCE tuple `["<uuid>"]` or a primitive. The variant-keyed maps
 * (`rs`/`attrs`/`eventHandlers`: `Map<Set<Variant>, …>`) key on a `Set<Variant>` → a `Set`-prefixed
 * key of variant ref-tuples.
 *
 * Plexus's own `deserializeKey` resolves each ref to a LIVE `PlexusModel` (via `deref`) — but the
 * history archive is a raw, merged gc:false `Y.Doc` with NO model bindings, so deref is the wrong
 * tool. This twin stops at the {@link EntityRef} (uuid + type); the product names it later via
 * `ctx.nameOf`. The wire format is OWNED by key-serialization.ts — kept in lockstep here.
 *
 * Contract: call only on a serialized (prefixed) key — i.e. the `comboMeta` of a map/set-keyed child.
 * Record-keyed children carry a plain (unprefixed) string in `comboMeta`; don't route those here.
 */

const BIGINT_REGEX = /^-?\d+n$/;

/** A combo member: an entity reference, or a primitive value. */
export type ComboMember = { ref: EntityRef } | { value: unknown };

/** A parsed serialized map/set key. `kind` mirrors the serialized prefix; `value` carries exactly one member. */
export interface ComboKey {
  kind: "set" | "array" | "value";
  members: ComboMember[];
}

/** Parse one serialized line → a ref member (entity-ref tuple) or a primitive value member. */
function parseLine(line: string, archive: Y.Doc): ComboMember {
  if (BIGINT_REGEX.test(line)) return { value: BigInt(line.slice(0, -1)) };
  if (line === "NaN") return { value: Number.NaN };
  if (line === "Infinity") return { value: Infinity };
  if (line === "-Infinity") return { value: -Infinity };

  const parsed: unknown = JSON.parse(line);
  // A reference tuple is `["<uuid>"]` or `["<uuid>", "<docId>"]` (deserializeValueFlexible's shape).
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 2 && typeof parsed[0] === "string") {
    return { ref: refByUuid(archive, parsed[0]) };
  }
  return { value: parsed };
}

/**
 * Parse a Plexus `serializeKey` string into refs/primitives (the ref-level twin of `deserializeKey`).
 * Empty `Set`/`Array` → `members: []`. Throws on an unknown prefix (loud — not a silent miss).
 */
export function parseComboKey(serialized: string, archive: Y.Doc): ComboKey {
  const [prefix, ...lines] = serialized.split("\n");
  const members = lines.map((line) => parseLine(line, archive));
  switch (prefix) {
    case "Set":
      return { kind: "set", members };
    case "Array":
      return { kind: "array", members };
    case "Value":
      if (members.length !== 1) {
        throw new TypeError(`plexus-history: a Value key must have exactly one member, got ${members.length}`);
      }
      return { kind: "value", members };
    default:
      throw new TypeError(`plexus-history: invalid prefix "${prefix}" for serialized map key`);
  }
}
