import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { PlexusFS } from "../models/PlexusFS.js";
import { PlexusFile } from "../models/PlexusFile.js";

/**
 * Uint8Array read-side view-compatibility harness.
 *
 * A scalar `@syncing accessor content: Uint8Array` reads back as the live CRDT
 * typed-array PROXY — array-like + iterable, but NOT a genuine `ArrayBufferView`.
 * Structured Web APIs (`TextDecoder`, `Blob`, `Y.applyUpdate`, R2 `put`) reject a
 * non-view, which is exactly what broke plexus-vfs (`readFile → TextDecoder`).
 *
 * Two blocks:
 *  1. "read boundary … invariant" — the user-facing guarantee: `readFile` /
 *     `bytes` / `promises.readFile` yield a genuine, structured-API-usable
 *     Uint8Array. GREEN today via `PlexusFile.bytes`' `Uint8Array.from` copy.
 *     This is location-agnostic: if the materialize moves INTO Plexus's
 *     read-side (and the plexus-vfs workaround is dropped), these stay green.
 *  2. "raw `content` … it.fails" — pins the underlying gap. Each `it.fails`
 *     PASSES while the proxy is non-view (asserting the desired end-state that
 *     currently throws/fails), and FLIPS to failing the moment Plexus's
 *     read-side returns a real view — the signal that the root fix landed
 *     (promote those to `it`, drop the plexus-vfs `bytes` materialize).
 */

function makeFS(): PlexusFS {
  const fs = new PlexusFS();
  Plexus.bootstrap(fs, undefined, new Y.Doc());
  return fs;
}

function rawContentOf(fs: PlexusFS, path: string): Uint8Array {
  const file = fs.resolve(path);
  if (!(file instanceof PlexusFile)) throw new Error(`not a file: ${path}`);
  return file.content; // the live proxy, NOT the materialized `bytes` getter
}

describe("read boundary — structured-Web-API compatibility (the invariant)", () => {
  it("readFile returns a genuine Uint8Array / ArrayBufferView", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hello");
    const bytes = fs.readFile("a.txt");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(ArrayBuffer.isView(bytes)).toBe(true);
  });

  it("TextDecoder.decode round-trips text through readFile (the original break)", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hello world");
    expect(() => new TextDecoder().decode(fs.readFile("a.txt"))).not.toThrow();
    expect(new TextDecoder().decode(fs.readFile("a.txt"))).toBe("hello world");
  });

  it("the read value exposes a working .buffer / .byteLength / .subarray", () => {
    const fs = makeFS();
    fs.writeFile("a.bin", new Uint8Array([1, 2, 3, 4]));
    const bytes = fs.readFile("a.bin");
    expect(bytes.byteLength).toBe(4);
    expect(bytes.buffer.byteLength).toBeGreaterThanOrEqual(4);
    expect([...bytes.subarray(1, 3)]).toEqual([2, 3]);
  });

  it("the read value re-views + constructs a Blob (accepted as a BufferSource)", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "café");
    const bytes = fs.readFile("a.txt");
    expect([...new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)]).toEqual([...bytes]);
    expect(new Blob([bytes as Uint8Array<ArrayBuffer>]).size).toBe(bytes.byteLength);
  });

  it("promises.readFile('utf8') decodes; raw promises.readFile is a view", async () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hi");
    expect(await fs.promises.readFile("a.txt", "utf8")).toBe("hi");
    const raw = await fs.promises.readFile("a.txt");
    expect(ArrayBuffer.isView(raw as Uint8Array)).toBe(true);
  });

  it("full binary fidelity (0x00–0xFF + embedded NUL) survives the view round-trip", () => {
    const fs = makeFS();
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    fs.writeFile("all.bin", all);
    const back = fs.readFile("all.bin");
    expect(ArrayBuffer.isView(back)).toBe(true);
    expect([...back]).toEqual([...all]);
  });

  it("CRDT sync round-trips bytes + view-compat to a second doc", () => {
    const docA = new Y.Doc();
    const fsA = new PlexusFS();
    Plexus.bootstrap(fsA, undefined, docA);
    fsA.writeFile("x.txt", "synced");

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const fsB = Plexus.connect(docB).root as PlexusFS;

    const bytes = fsB.readFile("x.txt");
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(new TextDecoder().decode(bytes)).toBe("synced");
  });
});

describe("raw `content` field — the Plexus read-side gap (it.fails until Plexus returns a view)", () => {
  it("today: raw content IS instanceof Uint8Array + array-like/iterable/indexable — but is a Proxy, NOT a genuine view", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hello");
    const raw = rawContentOf(fs, "a.txt");
    // instanceof passes (the proxy's target is a real Uint8Array, so the prototype chain matches)…
    expect(raw).toBeInstanceOf(Uint8Array);
    // …array-like + iterable + indexable, so Uint8Array.from(raw) (the materialize path) works…
    expect(raw.length).toBe(5);
    expect(raw[0]).toBe("h".charCodeAt(0));
    expect([...raw]).toEqual([...new TextEncoder().encode("hello")]);
    expect(Uint8Array.from(raw)).toBeInstanceOf(Uint8Array);
    // …but it is NOT the actual backing ArrayBufferView — this is the gap the two it.fails below pin.
    expect(ArrayBuffer.isView(raw)).toBe(false);
  });

  it.fails("raw content should be an ArrayBufferView (Plexus read-side should hand back the real view)", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hello");
    expect(ArrayBuffer.isView(rawContentOf(fs, "a.txt"))).toBe(true);
  });

  it.fails("TextDecoder should decode raw content directly (no Uint8Array.from materialize)", () => {
    const fs = makeFS();
    fs.writeFile("a.txt", "hello");
    expect(new TextDecoder().decode(rawContentOf(fs, "a.txt"))).toBe("hello");
  });
});
