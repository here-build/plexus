import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { PlexusFS } from "../models/PlexusFS.js";

const author = { name: "VFS Test", email: "vfs@here.build" };

describe("isomorphic-git drop-in conformance", () => {
  it("exposes an enumerable `promises` property (iso-git's detection signal)", () => {
    const fs = new PlexusFS();
    expect(Object.prototype.propertyIsEnumerable.call(fs, "promises")).to.equal(true);
  });

  it("init → write → add → commit → log round-trips a real repo", async () => {
    const fs = new PlexusFS();
    const dir = "/";

    await git.init({ fs, dir });
    await fs.promises.writeFile("/README.md", "# Hello from Plexus VFS\n");
    await git.add({ fs, dir, filepath: "README.md" });
    const oid = await git.commit({ fs, dir, message: "initial commit", author });

    expect(typeof oid).to.equal("string");
    expect(oid).to.have.length(40); // sha-1 hex

    const log = await git.log({ fs, dir });
    expect(log).to.have.length(1);
    const [head] = log;
    expect(head).to.not.equal(undefined);
    expect(head!.oid).to.equal(oid);
    expect(head!.commit.message).to.equal("initial commit\n");
    expect(head!.commit.author.name).to.equal(author.name);
  });

  it("listFiles reflects the committed index", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir });

    await fs.promises.writeFile("/a.txt", "alpha");
    await fs.promises.writeFile("/nested/b.txt", "beta");
    await git.add({ fs, dir, filepath: "a.txt" });
    await git.add({ fs, dir, filepath: "nested/b.txt" });
    await git.commit({ fs, dir, message: "two files", author });

    const files = await git.listFiles({ fs, dir });
    expect(files.toSorted((a, b) => a.localeCompare(b))).to.deep.equal(["a.txt", "nested/b.txt"]);
  });

  it("multiple commits build a log history", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir });

    await fs.promises.writeFile("/f.txt", "v1");
    await git.add({ fs, dir, filepath: "f.txt" });
    const c1 = await git.commit({ fs, dir, message: "v1", author });

    await fs.promises.writeFile("/f.txt", "v2 — longer content with binary-ish ÿ bytes");
    await git.add({ fs, dir, filepath: "f.txt" });
    const c2 = await git.commit({ fs, dir, message: "v2", author });

    const log = await git.log({ fs, dir });
    expect(log.map((e) => e.oid)).to.deep.equal([c2, c1]);
  });

  it("checkout round-trips committed content back onto the working tree", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir });

    const original = "checkout me\n";
    await fs.promises.writeFile("/file.txt", original);
    await git.add({ fs, dir, filepath: "file.txt" });
    await git.commit({ fs, dir, message: "commit for checkout", author });

    // Mutate the working tree, then checkout to restore from the commit.
    await fs.promises.writeFile("/file.txt", "dirty edit");
    expect(fs.resolve("file.txt")).to.not.equal(null);

    await git.checkout({ fs, dir, force: true });

    const restored = await fs.promises.readFile("/file.txt", { encoding: "utf8" });
    expect(restored).to.equal(original);
  });

  it("readFile honors the utf8 encoding option vs raw bytes", async () => {
    const fs = new PlexusFS();
    await fs.promises.writeFile("/x", "t**bytes**");
    const asBytes = await fs.promises.readFile("/x");
    const asText = await fs.promises.readFile("/x", { encoding: "utf8" });
    expect(asBytes).to.be.instanceOf(Uint8Array);
    expect(typeof asText).to.equal("string");
    expect(asText).to.equal("t**bytes**");
  });

  it("git objects (binary) survive raw byte storage — re-reading a blob", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir });

    // Arbitrary binary payload, including 0x00 and high bytes.
    const payload = new Uint8Array(512);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    await fs.promises.writeFile("/data.bin", payload);
    await git.add({ fs, dir, filepath: "data.bin" });
    const oid = await git.commit({ fs, dir, message: "binary blob", author });

    // Read the blob back out of the object store iso-git wrote (deflated, binary).
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid,
      filepath: "data.bin",
    });
    expect([...blob]).to.deep.equal([...payload]);
  });

  // ── Broader drop-in surface: prove a real spread of git operations work ──────

  it("statusMatrix reports committed / modified / untracked states", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile("/committed.txt", "v1");
    await git.add({ fs, dir, filepath: "committed.txt" });
    await git.commit({ fs, dir, message: "base", author });

    // modify the committed file (a DIFFERENT length, so iso-git's racy-git
    // size+mtime shortcut can't false-negative when both writes share a
    // millisecond), and add a brand-new untracked one
    await fs.promises.writeFile("/committed.txt", "v2 — modified, a clearly different length");
    await fs.promises.writeFile("/untracked.txt", "new");

    const matrix = await git.statusMatrix({ fs, dir });
    const row = (f: string) => matrix.find(([p]) => p === f);

    // [filepath, HEAD, WORKDIR, STAGE]
    expect(row("committed.txt")).to.deep.equal(["committed.txt", 1, 2, 1]); // modified, unstaged
    expect(row("untracked.txt")).to.deep.equal(["untracked.txt", 0, 2, 0]); // new, untracked
  });

  it("branch + checkout switches the working tree and index between refs", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile("/base.txt", "base");
    await git.add({ fs, dir, filepath: "base.txt" });
    await git.commit({ fs, dir, message: "base", author });

    // create + switch to a feature branch, commit a file only it has
    await git.branch({ fs, dir, ref: "feature", checkout: true });
    expect(await git.currentBranch({ fs, dir })).to.equal("feature");
    await fs.promises.writeFile("/feature-only.txt", "feature");
    await git.add({ fs, dir, filepath: "feature-only.txt" });
    await git.commit({ fs, dir, message: "feature work", author });

    // back to main — feature's file is absent from both index and working tree
    await git.checkout({ fs, dir, ref: "main" });
    expect(await git.currentBranch({ fs, dir })).to.equal("main");
    expect(await git.listFiles({ fs, dir })).to.deep.equal(["base.txt"]);
    await expect(fs.promises.readFile("/feature-only.txt")).rejects.toThrow(/ENOENT/);

    // back to feature — the file returns to the working tree
    await git.checkout({ fs, dir, ref: "feature" });
    expect(await fs.promises.readFile("/feature-only.txt", { encoding: "utf8" })).to.equal("feature");
  });

  it("git.remove drops a file from the next commit's tree", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile("/keep.txt", "keep");
    await fs.promises.writeFile("/drop.txt", "drop");
    await git.add({ fs, dir, filepath: "keep.txt" });
    await git.add({ fs, dir, filepath: "drop.txt" });
    await git.commit({ fs, dir, message: "two files", author });

    await git.remove({ fs, dir, filepath: "drop.txt" });
    await git.commit({ fs, dir, message: "drop one", author });

    expect(await git.listFiles({ fs, dir })).to.deep.equal(["keep.txt"]);
  });

  it("readCommit + readTree expose the committed object graph", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile("/a.txt", "alpha");
    await git.add({ fs, dir, filepath: "a.txt" });
    const oid = await git.commit({ fs, dir, message: "msg", author });

    const { commit } = await git.readCommit({ fs, dir, oid });
    expect(commit.message).to.equal("msg\n");
    expect(typeof commit.tree).to.equal("string");

    const { tree } = await git.readTree({ fs, dir, oid: commit.tree });
    expect(tree.map((entry) => entry.path)).to.include("a.txt");
  });

  it("tag + listTags round-trips a ref", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile("/x.txt", "x");
    await git.add({ fs, dir, filepath: "x.txt" });
    await git.commit({ fs, dir, message: "for tag", author });

    await git.tag({ fs, dir, ref: "v1.0.0" });
    expect(await git.listTags({ fs, dir })).to.include("v1.0.0");
  });

  it("a deep nested tree commits and lists every file (mkdir -p stress)", async () => {
    const fs = new PlexusFS();
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    const paths = ["src/a.ts", "src/lib/b.ts", "src/lib/util/c.ts", "docs/readme.md"];
    for (const p of paths) {
      await fs.promises.writeFile(`/${p}`, `// ${p}`);
      await git.add({ fs, dir, filepath: p });
    }
    await git.commit({ fs, dir, message: "nested tree", author });

    const sorted = (xs: string[]) => xs.toSorted((a, b) => a.localeCompare(b));
    expect(sorted(await git.listFiles({ fs, dir }))).to.deep.equal(sorted(paths));
  });
});
