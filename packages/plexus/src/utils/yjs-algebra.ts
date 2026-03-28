import * as Y from "yjs";

/**
 * Build a state vector that excludes a specific client.
 * When used with encodeStateAsUpdate, this produces only the target client's Items.
 */
export const getSelectiveStateVector = (doc: Y.Doc, targetClient = doc.clientID) => {
  const store = doc.store;
  const sm = new Map<number, number>();
  store.clients.forEach((structs, client) => {
    if (client === targetClient) return;
    const struct = structs.at(-1)!;
    sm.set(client, struct.id.clock + struct.length);
  });
  return sm;
};

/**
 * Encode only the Items belonging to a specific client.
 */
export const getIndividualVector = (doc: Y.Doc, targetClient = doc.clientID) =>
  Y.encodeStateAsUpdate(doc, Y.encodeStateVector(getSelectiveStateVector(doc, targetClient)));

/**
 * Extract committed delta from shadow doc via clientId rewrite.
 *
 * Temporarily rewrites liminal Items (id + origin + rightOrigin) to the
 * committed-liminal namespace, encodes a delta against main's state vector,
 * then restores.
 *
 * IMPORTANT: The shadow doc must use a FRESH clientId per liminal session
 * (assigned in enterLiminality). This ensures only liminal Items are under
 * limId — prior normal writes use a different clientId and are untouched.
 *
 * @param shadow - Shadow doc containing liminal Items
 * @param main - Main doc (for state vector comparison)
 * @param limId - Current liminal clientId on shadow
 * @param liminalBase - LIMINAL_BASE offset for committed namespace
 */
export function extractCommittedDelta(shadow: Y.Doc, main: Y.Doc, limId: number, liminalBase: number): Uint8Array {
  const committedId = limId + liminalBase;
  const clients = (shadow.store as any).clients as Map<number, any[]>;
  const structs = clients.get(limId);
  if (!structs?.length) return new Uint8Array([0, 0]);

  // 1. Rewrite: limId → committedId (temporary, in-place)
  clients.delete(limId);
  clients.set(committedId, structs);
  const saved: Array<{ id: any; origin: any; rightOrigin: any }> = [];
  for (const s of structs) {
    saved.push({ id: s.id, origin: s.origin, rightOrigin: s.rightOrigin });
    s.id = new Y.ID(committedId, s.id.clock);
    if (s.origin?.client === limId) s.origin = new Y.ID(committedId, s.origin.clock);
    if (s.rightOrigin?.client === limId) s.rightOrigin = new Y.ID(committedId, s.rightOrigin.clock);
  }

  // 2. Encode against main's state vector.
  const delta = Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(main));

  // 3. Restore: committedId → limId
  for (let i = 0; i < structs.length; i++) {
    structs[i].id = saved[i].id;
    structs[i].origin = saved[i].origin;
    structs[i].rightOrigin = saved[i].rightOrigin;
  }
  clients.delete(committedId);
  clients.set(limId, structs);

  return delta;
}
