import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

// Entity-sequence Peritext: TextAtoms + void Marker entities in a child.list.

function emptyText() {
  return new PlexusText({});
}

function seed(root: PlexusText, s: string) {
  insertTextAt(root, 0, s);
}

describe("PlexusText — Peritext with entity markers", () => {
  it("projects the sequence to constant-format leaf runs", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "hello world");
    addMark(root, 6, 11, "bold");

    expect(toText(root)).to.equal("hello world");
    expect(segments(root)).to.deep.equal([
      { text: "hello ", marks: {} },
      { text: "world", marks: { bold: true } },
    ]);
  });

  it("nested same-type marks: the inner close re-exposes the outer (the stack fix)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "AA BB CC");
    addMark(root, 0, 8, "color", "red");
    addMark(root, 3, 5, "color", "blue");

    expect(segments(root)).to.deep.equal([
      { text: "AA ", marks: { color: "red" } },
      { text: "BB", marks: { color: "blue" } },
      { text: " CC", marks: { color: "red" } },
    ]);
  });

  it("overlapping different-type spans project to three runs", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "abcdef");
    addMark(root, 0, 4, "bold");
    addMark(root, 2, 6, "italic");

    expect(segments(root)).to.deep.equal([
      { text: "ab", marks: { bold: true } },
      { text: "cd", marks: { bold: true, italic: true } },
      { text: "ef", marks: { italic: true } },
    ]);
  });

  it("a mark tracks its characters across an edit before it (the Peritext property)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "hello world");
    addMark(root, 6, 11, "bold");
    insertTextAt(root, 6, "big "); // before "world"

    expect(toText(root)).to.equal("hello big world");
    expect(segments(root)).to.deep.equal([
      { text: "hello big ", marks: {} },
      { text: "world", marks: { bold: true } },
    ]);
  });

  it("converges across two peers (text + marks)", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(emptyText());
    seed(rootA, "hello world");
    addMark(rootA, 6, 11, "bold");

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { root: rootB } = connectTestPlexus<PlexusText>(docB);

    expect(toText(rootB)).to.equal("hello world");
    expect(segments(rootB)).to.deep.equal(segments(rootA));
  });

  it("crossing same-type spans pair by intent, not by nearest-close", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "wxyz");
    addMark(root, 0, 3, "link", "A"); // "wxy" = link A
    addMark(root, 1, 4, "link", "B"); // "xyz" = link B — crosses A

    expect(segments(root)).to.deep.equal([
      { text: "w", marks: { link: "A" } },
      { text: "xyz", marks: { link: "B" } },
    ]);
  });

  it("a delete spanning a mark's close collapses onto the preserved markers — the span shrinks, no bleed", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    seed(root, "hello world");
    addMark(root, 0, 5, "bold"); // "hello" bold
    deleteTextRange(root, 3, 8);

    expect(toText(root)).to.equal("helrld");
    expect(segments(root)).to.deep.equal([
      { text: "hel", marks: { bold: true } },
      { text: "rld", marks: {} },
    ]);
  });
});
