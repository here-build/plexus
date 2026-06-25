import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * Load-bearing Yjs transaction behaviour that `genesisApplyUpdate` (genesis-client.ts)
 * relies on — pinned here so a Yjs version bump can't change it silently underneath us.
 *
 * Two facts:
 *  1. A SINGLE transaction can author under one clientId AND integrate foreign structs
 *     under another, and emit ONE update carrying both — i.e. multi-clientId sync works.
 *  2. `applyUpdate` FORCES `transaction.local = false`, even when reusing an active
 *     transaction. If the doc also authored under its OWN clientId, Yjs's cleanup check
 *     then "rerolls" that clientId (Transaction.js:357). Restoring `transaction.local =
 *     true` after the applyUpdate prevents it — which is exactly what genesisApplyUpdate
 *     does to keep the shadow clientId inside its Plexus partition.
 */

function foreignUpdateUnder(clientID: number, key: string, val: string): Uint8Array {
  const foreign = new Y.Doc();
  foreign.clientID = clientID;
  foreign.getMap("root").set(key, val);
  return Y.encodeStateAsUpdate(foreign);
}

describe("Yjs: single-transaction multi-clientId + the local flag", () => {
  it("one transaction authoring X + integrating foreign Y emits one update carrying both, and it syncs", () => {
    const fY = foreignUpdateUnder(999, "fromY", "genesis");
    const docA = new Y.Doc();
    docA.clientID = 111;
    const updates: Uint8Array[] = [];
    docA.on("update", (u: Uint8Array) => updates.push(u));

    docA.transact((txn) => {
      docA.getMap("root").set("fromX", "intent"); // author under 111
      Y.applyUpdate(docA, fY); // integrate foreign 999 — reuses this transaction
      txn.local = true; // (restore — see facts; not what's under test here)
    }, "atomic");

    // ONE update, carrying BOTH clientIds, reconstructs on a fresh peer.
    expect(updates.length).to.equal(1);
    const docB = new Y.Doc();
    for (const u of updates) Y.applyUpdate(docB, u);
    expect(docB.getMap("root").get("fromX")).to.equal("intent");
    expect(docB.getMap("root").get("fromY")).to.equal("genesis");
    expect([...docB.store.clients.keys()].sort((a, b) => a - b)).to.deep.equal([111, 999]);
  });

  it("restoring transaction.local=true after the foreign applyUpdate keeps the authoring clientId", () => {
    // Without the `txn.local = true` line, applyUpdate's forced local=false would make
    // Yjs reroll docA.clientID at cleanup (the bug genesisApplyUpdate fixes).
    const fY = foreignUpdateUnder(999, "fromY", "genesis");
    const docA = new Y.Doc();
    docA.clientID = 111;

    docA.transact((txn) => {
      docA.getMap("root").set("fromX", "intent");
      Y.applyUpdate(docA, fY);
      txn.local = true;
    }, "atomic");

    expect(docA.clientID).to.equal(111);
  });

  it("the local-restore is order-independent (foreign applyUpdate first, then author)", () => {
    const fY = foreignUpdateUnder(999, "fromY", "genesis");
    const docA = new Y.Doc();
    docA.clientID = 111;

    docA.transact((txn) => {
      Y.applyUpdate(docA, fY);
      docA.getMap("root").set("fromX", "intent");
      txn.local = true;
    }, "atomic");

    expect(docA.clientID).to.equal(111);
  });
});
