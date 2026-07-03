/**
 * @here.build/plexus/internals — plumbing exposed for the plexus FAMILY
 * (plexus-history and other extra tooling), not for autonomous use by
 * application code. No stability promise beyond the family's needs.
 */

// CRDT-native UUID codec — reused by @here.build/plexus-history to resolve an
// entity's uuid from a struct in O(1) via encodePlexusUUID(xmlElement._item.id).
export { encode as encodePlexusUUID, decode as decodePlexusUUID } from "./crdt-uuid.js";
