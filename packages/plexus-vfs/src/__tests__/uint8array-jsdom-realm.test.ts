// @vitest-environment jsdom
//
// The REAL foreign-realm repro (found by inhuman-studio's suite, which runs
// vitest environment:"jsdom"): jsdom's TextEncoder yields a Uint8Array from
// jsdom's realm; plexus-core's value classifier dispatches on constructor
// identity and rejects it with the deliberately self-contradictory
//   PlexusUnstorableValueError: cannot store a value of type Uint8Array —
//   a Plexus field holds … or a Uint8Array
// (it IS a Uint8Array — just not this realm's). plexus-vfs normalizes on
// ingest (PlexusFile.normalizeBytes) so consumers never see this. This file
// pins that red→green permanently; before the normalize, every write below
// threw.
import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { PlexusFS } from "../models/PlexusFS.js";
import { PlexusFile } from "../models/PlexusFile.js";

const makeFS = (): PlexusFS => Plexus.bootstrap(new PlexusFS(), undefined, new Y.Doc()).root;

describe("jsdom realm — writes normalize on ingest (the studio-suite repro)", () => {
  it("string write (jsdom TextEncoder path) round-trips", () => {
    const fs = makeFS();
    fs.writeFile("a.scm", "(x)");
    expect([...fs.readFile("a.scm")]).toEqual([...new TextEncoder().encode("(x)")]);
    expect(new TextDecoder().decode(fs.readFile("a.scm"))).toBe("(x)");
  });

  it("explicit jsdom-realm Uint8Array write round-trips", () => {
    const fs = makeFS();
    fs.writeFile("b.bin", new TextEncoder().encode("bytes!"));
    expect(new TextDecoder().decode(fs.readFile("b.bin"))).toBe("bytes!");
  });

  it("text setter path round-trips", () => {
    const fs = makeFS();
    fs.writeFile("c.txt", "seed");
    const file = fs.resolve("c.txt") as PlexusFile;
    file.text = "overwritten";
    expect(file.text).toBe("overwritten");
  });
});
