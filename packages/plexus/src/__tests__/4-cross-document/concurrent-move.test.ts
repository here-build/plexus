/**
 * Characterization test for the "move-CRDT" redundant-edge problem.
 *
 * Ownership is stored REDUNDANTLY in Plexus: a parent holds the child in a
 * collection field (Y.Map/Y.Array), AND the child holds a single parent-pointer
 * (`PARENT_ATTR`). The single-pointer LWW argument (see the @syncing.action
 * design proposal §8, "moves preserve identity") only reconciles the POINTER,
 * not the two collection edges.
 *
 * This test pins the ACTUAL current behavior of a concurrent cross-parent move
 * of the SAME entity on two peers. It is the concrete repro behind the
 * "move-crdt — yes, this is the internal problem for us" acknowledgement, so
 * the divergence is captured as a test rather than living only in a doc.
 *
 * If a future change makes moves genuinely single-parent-convergent (e.g. a
 * read-time `child.parent === owner` reconciliation filter, or a move-CRDT),
 * this test's expectations become the record of what changed.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Node")
class Node extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.list
  accessor children: Node[] = [];
}

@syncing("Root")
class Root extends PlexusModel {
  @syncing.record
  accessor slots!: Record<string, Node>;
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("Concurrent cross-parent move (redundant-edge / move-CRDT)", () => {
  it("duplicates E across every parent (redundant collection edges do not reconcile)", () => {
    // Peer 1
    const { doc: doc1, root: root1 } = initTestPlexus<Root>(new Root({ slots: {} }));
    const a = new Node({ name: "A", children: [] });
    const b = new Node({ name: "B", children: [] });
    const c = new Node({ name: "C", children: [] });
    const e = new Node({ name: "E", children: [] });
    root1.slots["a"] = a;
    root1.slots["b"] = b;
    root1.slots["c"] = c;
    a.children.push(e); // E starts under A

    // Peer 2 shares the guid so CRDT-native UUIDs decode on both peers
    const doc2 = new Y.Doc({ guid: doc1.guid });
    syncDocs(doc1, doc2);
    const { root: root2 } = connectTestPlexus<Root>(doc2);

    // sanity: E under A on both peers before the concurrent move
    expect(root1.slots["a"].children.map((n) => n.name)).toEqual(["E"]);
    expect(root2.slots["a"].children.map((n) => n.name)).toEqual(["E"]);

    const e1 = root1.slots["a"].children[0];
    const e2 = root2.slots["a"].children[0];
    expect(e1.uuid).toBe(e2.uuid); // same logical entity on both peers

    // CONCURRENT MOVE of the same entity, before any sync:
    root1.slots["b"].children.push(e1); // peer1: A -> B
    root2.slots["c"].children.push(e2); // peer2: A -> C

    // merge
    syncDocs(doc1, doc2);

    // The two peers DO converge to the same (wrong) tree — CRDT convergence
    // holds; it's tree-shape correctness that doesn't.
    expect(root1.slots["b"].children.map((n) => n.name)).toEqual(root2.slots["b"].children.map((n) => n.name));
    expect(root1.slots["c"].children.map((n) => n.name)).toEqual(root2.slots["c"].children.map((n) => n.name));
    expect(root1.slots["a"].children.map((n) => n.name)).toEqual(root2.slots["a"].children.map((n) => n.name));

    const aHasE = root1.slots["a"].children.some((n) => n.name === "E");
    const bHasE = root1.slots["b"].children.some((n) => n.name === "E");
    const cHasE = root1.slots["c"].children.some((n) => n.name === "E");
    const parentCount = [aHasE, bHasE, cHasE].filter(Boolean).length;

    // OBSERVED (current, buggy) behavior: after a concurrent cross-parent move,
    // E is present under ALL THREE collection edges — the two target parents it
    // was moved into (B, C) AND the source parent (A) it was moved out of, whose
    // concurrent emancipations do not net out. The single parent-POINTER is LWW
    // and picks one; the redundant collection edges are never reconciled on read
    // (`values()` yields the backing store with no `child.parent === owner`
    // filter). This is the "move-crdt … internal problem" — a move is not one
    // write, and §8's "moves preserve identity" holds only for the pointer.
    //
    // TARGET behavior (when a move-CRDT or read-time reconciliation lands):
    //   expect(parentCount).toBe(1);
    // Flip this assertion then, and this test becomes the record of the fix.
    expect(parentCount).toBe(3);
  });
});
