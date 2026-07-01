/**
 * Compile-time contract for the Uint8Array value/key split.
 *
 * Bytes are payload, not identity — legal wherever a value is addressed by its
 * position, forbidden wherever membership/lookup is by content:
 *
 *   LEGAL   → val field, record value, array element, map value
 *   ILLEGAL → set member, map key
 *
 * This file is type-checked (never executed). Each `@ts-expect-error` is the
 * exoskeleton: if the union is ever widened back so bytes become a legal
 * key/member, the directive goes unused and `tsc` fails the typecheck — the
 * regression is caught at compile time, before the runtime backstop in
 * `key-serialization.ts` ever runs.
 */

import { PlexusModel, syncing } from "../../index.js";

// ── LEGAL: bytes as a value ─────────────────────────────────────────
@syncing("BytesAsValues")
class BytesAsValues extends PlexusModel {
  @syncing accessor scalar!: Uint8Array; // val field
  @syncing.record accessor byKey: Record<string, Uint8Array> = {}; // record value
  @syncing.list accessor blobs: Uint8Array[] = []; // array element
  @syncing.map accessor byName!: Map<string, Uint8Array>; // map value
}
void BytesAsValues;

// ── ILLEGAL: bytes as a set member ──────────────────────────────────
@syncing("BytesAsSetMember")
class BytesAsSetMember extends PlexusModel {
  // @ts-expect-error — Uint8Array is content-shaped but object-identified; not a set member.
  @syncing.set accessor tags!: Set<Uint8Array>;
}
void BytesAsSetMember;

// ── ILLEGAL: bytes as a map key ─────────────────────────────────────
@syncing("BytesAsMapKey")
class BytesAsMapKey extends PlexusModel {
  // @ts-expect-error — Uint8Array cannot address a map entry; key by a name or id.
  @syncing.map accessor byBytes!: Map<Uint8Array, string>;
}
void BytesAsMapKey;

// ── Control: identity-bearing key primitives still work as members/keys ──
@syncing("ValidKeys")
class ValidKeys extends PlexusModel {
  @syncing.set accessor tags!: Set<string>;
  @syncing.map accessor byName!: Map<string, Uint8Array>;
}
void ValidKeys;
