import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * Differential oracle (V's design): a distributed run with convergence-points-at-overlap
 * must produce the SAME result as the LOCAL sequential run. Cross-peer equality only
 * proves peers AGREE; the local run is ground truth, so this catches loss/duplication.
 *
 * These three scenarios were RED under the naive segment-split (it re-created Y.Texts,
 * orphaning a concurrent peer's edit). They are GREEN under the embed model: `addMark`
 * inserts marker embeds NON-destructively into the one Y.Text, so a concurrent
 * edit/format/delete merges as plain yjs — no re-creation, nothing to orphan.
 *
 * NOTE: these compare `toText`, which is blind to MARK loss. The segments()-level
 * differential (which catches the projection's overlap/crossing mis-attribution the CRDT
 * critique found) lands with the id-paired projection in Step 3a.
 */

function emptyText() {
  return new PlexusText({});
}

function seedOne(text: PlexusText, s: string): void {
  insertTextAt(text, 0, s);
}

function syncBoth(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** Run a scenario locally (sequential, ground truth) and distributed (concurrent), compare. */
function differential(
  seed: string,
  local: (text: PlexusText) => void,
  a: (text: PlexusText) => void,
  b: (text: PlexusText) => void,
): { expected: string; distA: string; distB: string } {
  const ref = initTestPlexus<PlexusText>(emptyText());
  seedOne(ref.root, seed);
  local(ref.root);
  const expected = toText(ref.root);

  const peerA = initTestPlexus<PlexusText>(emptyText());
  seedOne(peerA.root, seed);
  const docB = new Y.Doc({ guid: peerA.doc.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(peerA.doc));
  const rootB = connectTestPlexus<PlexusText>(docB).root;

  a(peerA.root);
  b(rootB);
  syncBoth(peerA.doc, docB);
  return { expected, distA: toText(peerA.root), distB: toText(rootB) };
}

describe("embed model dissolves the corruption — distributed == local", () => {
  it("concurrent addMark-split vs a disjoint edit keeps the edit", () => {
    const { expected, distA, distB } = differential(
      "hello world",
      (t) => {
        addMark(t, 0, 5, "bold");
        insertTextAt(t, 8, "XYZ");
      },
      (t) => addMark(t, 0, 5, "bold"),
      (t) => insertTextAt(t, 8, "XYZ"),
    );
    expect(distA).to.equal(expected); // "hello woXYZrld"
    expect(distB).to.equal(expected);
  });

  it("concurrent addMark-split vs addMark-split does not duplicate text", () => {
    const { expected, distA, distB } = differential(
      "hello world",
      (t) => {
        addMark(t, 0, 5, "bold");
        addMark(t, 6, 11, "italic");
      },
      (t) => addMark(t, 0, 5, "bold"),
      (t) => addMark(t, 6, 11, "italic"),
    );
    expect(distA).to.equal(expected); // "hello world"
    expect(distB).to.equal(expected);
  });

  it("concurrent addMark-split vs a delete keeps the delete", () => {
    const { expected, distA, distB } = differential(
      "hello world",
      (t) => {
        addMark(t, 5, 7, "bold");
        deleteTextRange(t, 3, 8);
      },
      (t) => addMark(t, 5, 7, "bold"),
      (t) => deleteTextRange(t, 3, 8),
    );
    expect(distA).to.equal(expected); // "helrld"
    expect(distB).to.equal(expected);
  });

  it("concurrent disjoint marks converge to the local SEGMENTS (mark-level oracle)", () => {
    // toText is blind to marks; this compares segments(), so it catches mark loss/mis-attribution.
    const ref = initTestPlexus<PlexusText>(emptyText());
    seedOne(ref.root, "hello world");
    addMark(ref.root, 0, 5, "bold");
    addMark(ref.root, 6, 11, "italic");
    const expected = segments(ref.root);

    const a = initTestPlexus<PlexusText>(emptyText());
    seedOne(a.root, "hello world");
    const docB = new Y.Doc({ guid: a.doc.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.doc));
    const b = connectTestPlexus<PlexusText>(docB).root;

    addMark(a.root, 0, 5, "bold");
    addMark(b, 6, 11, "italic");
    syncBoth(a.doc, docB);

    expect(segments(a.root)).to.deep.equal(expected);
    expect(segments(b)).to.deep.equal(expected);
  });
});
