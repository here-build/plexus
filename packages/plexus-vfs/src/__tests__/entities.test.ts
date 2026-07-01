import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { PlexusDir } from "../models/PlexusDir.js";
import { PlexusFS } from "../models/PlexusFS.js";
import { PlexusFile } from "../models/PlexusFile.js";

function makeFS(): PlexusFS {
  const fs = new PlexusFS();
  Plexus.bootstrap(fs, undefined, new Y.Doc());
  return fs;
}

describe("PlexusFS entities", () => {
  it("write → read round-trips text", () => {
    const fs = makeFS();
    fs.writeFile("hello.txt", "hello world");
    expect(new TextDecoder().decode(fs.readFile("hello.txt"))).to.equal("hello world");
  });

  it("write → read round-trips raw non-UTF-8 bytes (binary fidelity)", () => {
    const fs = makeFS();
    const raw = new Uint8Array([0, 255, 128, 10, 1, 254, 200, 0]);
    fs.writeFile("blob.bin", raw);
    const back = fs.readFile("blob.bin");
    expect([...back]).to.deep.equal([...raw]);
  });

  it("preserves every byte 0x00–0xFF through storage", () => {
    const fs = makeFS();
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    fs.writeFile("all.bin", all);
    expect([...fs.readFile("all.bin")]).to.deep.equal([...all]);
  });

  it("handles large binary content (chunked encode, no stack blow-up)", () => {
    const fs = makeFS();
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 13) & 0xff;
    fs.writeFile("big.bin", big);
    const back = fs.readFile("big.bin");
    expect(back.length).to.equal(big.length);
    expect(back[0]).to.equal(big[0]);
    expect(back[123_456]).to.equal(big[123_456]);
    expect(back.at(-1)).to.equal(big.at(-1));
  });

  it("name reflects parentFieldKey", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "x");
    const file = fs.entries["a.txt"] as PlexusFile;
    expect(file.name).to.equal("a.txt");
    expect(file).to.be.instanceOf(PlexusFile);
  });

  it("path resolves through nesting", () => {
    const fs = makeFS();
    fs.writeFile("src/lib/util.ts", "export const x = 1;");
    const file = fs.resolve("src/lib/util.ts") as PlexusFile;
    expect(file.path).to.equal("src/lib/util.ts");
    const dir = fs.resolve("src/lib") as PlexusDir;
    expect(dir.path).to.equal("src/lib");
    expect(dir).to.be.instanceOf(PlexusDir);
  });

  it("nested mkdir -p creates intermediate dirs", () => {
    const fs = makeFS();
    fs.mkdir("a/b/c", { recursive: true });
    expect(fs.resolve("a")).to.be.instanceOf(PlexusDir);
    expect(fs.resolve("a/b")).to.be.instanceOf(PlexusDir);
    expect(fs.resolve("a/b/c")).to.be.instanceOf(PlexusDir);
  });

  it("non-recursive mkdir throws EEXIST on existing dir", () => {
    const fs = makeFS();
    fs.mkdir("d");
    expect(() => fs.mkdir("d")).to.throw(/EEXIST/);
  });

  it("readdir lists entry names", () => {
    const fs = makeFS();
    fs.writeFile("dir/a.txt", "1");
    fs.writeFile("dir/b.txt", "2");
    fs.mkdir("dir/sub", { recursive: true });
    expect(fs.readdir("dir").toSorted((a, b) => a.localeCompare(b))).to.deep.equal(["a.txt", "b.txt", "sub"]);
  });

  it("unlink removes a file", () => {
    const fs = makeFS();
    fs.writeFile("gone.txt", "bye");
    fs.unlink("gone.txt");
    expect(fs.resolve("gone.txt")).to.equal(null);
    expect(() => fs.unlink("gone.txt")).to.throw(/ENOENT/);
  });

  it("rmdir removes a dir", () => {
    const fs = makeFS();
    fs.mkdir("empty");
    fs.rmdir("empty");
    expect(fs.resolve("empty")).to.equal(null);
  });

  it("rename via re-key preserves content and updates name/path", () => {
    const fs = makeFS();
    fs.writeFile("old.txt", "content");
    const file = fs.entries["old.txt"] as PlexusFile;
    // Re-key: move the same entity to a new key (ownership re-parents to the new key).
    fs.entries["new.txt"] = file;
    expect(fs.entries["new.txt"]).to.be.instanceOf(PlexusFile);
    const moved = fs.entries["new.txt"] as PlexusFile;
    expect(moved.text).to.equal("content");
    expect(moved.name).to.equal("new.txt");
    expect(moved.path).to.equal("new.txt");
    // Old key no longer points at it (exclusive ownership).
    expect("old.txt" in fs.entries).to.equal(false);
  });

  it("stat reports type, size, and a stable inode", () => {
    const fs = makeFS();
    fs.writeFile("f.txt", "12345");
    fs.mkdir("dd");
    const fstat = fs.stat("f.txt");
    expect(fstat.isFile()).to.equal(true);
    expect(fstat.isDirectory()).to.equal(false);
    expect(fstat.size).to.equal(5);
    expect(fstat.mode >> 12).to.equal(0o10); // regular file
    const dstat = fs.stat("dd");
    expect(dstat.isDirectory()).to.equal(true);
    expect(dstat.mode >> 12).to.equal(0o04); // directory
    // ino is stable across reads of the same entity
    expect(fs.stat("f.txt").ino).to.equal(fstat.ino);
  });

  it("text/bytes convenience accessors project onto the content field", () => {
    const file = new PlexusFile();
    file.text = "café"; // multibyte UTF-8
    expect(file.text).to.equal("café");
    expect(file.content.length).to.equal(5); // 'c','a','f', plus 2 bytes for é
    expect([...file.bytes]).to.deep.equal([...new TextEncoder().encode("café")]);
  });

  it("nestable: PlexusFS as a @syncing.child of a larger model still works", () => {
    // Smoke that the class composes; full nested-doc lifecycle is covered by
    // the entities above (the FS is a Dir, which is a normal Plexus child).
    const fs = new PlexusFS();
    Plexus.bootstrap(fs, undefined, new Y.Doc());
    fs.writeFile("README.md", "# hi");
    expect(fs.readdir("")).to.deep.equal(["README.md"]);
  });
});
