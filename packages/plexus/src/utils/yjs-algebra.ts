import * as Y from "yjs";

export const getSelectiveStateVector = (doc: Y.Doc, targetClient = doc.clientID) => {
  const store = doc.store;
  const sm = new Map();
  store.clients.forEach((structs, client) => {
    const struct = structs.at(-1)!;
    if (client === targetClient) {
      return;
    }
    sm.set(client, struct.id.clock + struct.length);
  });
  // @ts-expect-error
  store.skips.clients.forEach((range, client) => {
    if (client === targetClient) {
      return;
    }
    sm.set(client, range.getIds()[0].clock);
  });
  return sm;
};

export const getIndividualVector = (doc: Y.Doc, targetClient = doc.clientID) =>
  Y.encodeStateAsUpdateV2(doc, Y);
