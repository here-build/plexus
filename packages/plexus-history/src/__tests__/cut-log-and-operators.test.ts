import { encodePlexusUUID } from "@here.build/plexus/internals";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";

import { captureCut } from "../capture.js";
import { InMemoryCutLog } from "../cut-log.js";
import { changesSince, filterBy, groupBy, subtreeScope } from "../operators.js";
import type { Cut, PlexusChange } from "../types.js";

const NUL = String.fromCharCode(0);

function cut(seq: number, timestamp: number): Cut {
  return { seq, timestamp, author: null, afterState: new Map(), deletedRanges: new Map() };
}

describe("InMemoryCutLog", () => {
  test("strictly-increasing append (gaps tolerated) + get + range; backward/equal throws", () => {
    const log = new InMemoryCutLog();
    log.append(cut(0, 100));
    log.append(cut(1, 200));
    log.append(cut(2, 300));
    expect(log.latest()?.seq).toBe(2);
    expect(log.get(1)?.timestamp).toBe(200);
    expect(log.range(1, 2).map((c) => c.seq)).toEqual([1, 2]);
    log.append(cut(5, 400)); // a gap (e.g. a dropped/un-persisted cut) is tolerated — a missing frame, not a wedge
    expect(log.latest()?.seq).toBe(5);
    expect(log.get(5)?.timestamp).toBe(400);
    expect(() => log.append(cut(5, 500))).toThrow(); // equal seq → not strictly increasing
    expect(() => log.append(cut(3, 500))).toThrow(); // backward seq → throws
  });

  test("resolveRef HEAD / HEAD~n / @time / seq", () => {
    const log = new InMemoryCutLog();
    log.append(cut(0, 1000));
    log.append(cut(1, 2000));
    log.append(cut(2, 3000));
    expect(log.resolveRef("HEAD")?.seq).toBe(2);
    expect(log.resolveRef("HEAD~2")?.seq).toBe(0);
    expect(log.resolveRef(1)?.seq).toBe(1);
    expect(log.resolveRef(`@${new Date(2500).toISOString()}`)?.seq).toBe(1); // last cut with ts <= 2500
  });
});

function change(partial: Partial<PlexusChange>): PlexusChange {
  return { seq: 0, timestamp: 0, author: null, verb: "set", entity: { uuid: "u", type: "T" }, ...partial };
}

describe("filterBy / groupBy", () => {
  test("filterBy verb / kind / author", () => {
    const cs = [
      change({ verb: "set", author: { userId: "alice", kind: "human" } }),
      change({ verb: "detach", author: { userId: "bot", kind: "agent" } }),
      change({ verb: "set", author: { userId: "bot", kind: "agent" } }),
    ];
    expect(filterBy(cs, { verb: "set" })).toHaveLength(2);
    expect(filterBy(cs, { kind: "agent" })).toHaveLength(2);
    expect(filterBy(cs, { author: "alice" })).toHaveLength(1);
    expect(filterBy(cs, { verb: ["set", "detach"] })).toHaveLength(3);
  });

  test("groupBy author (consecutive) and burst (time window)", () => {
    const a = { userId: "a", kind: "human" as const };
    const b = { userId: "b", kind: "human" as const };
    const cs = [
      change({ author: a, timestamp: 0 }),
      change({ author: a, timestamp: 1000 }),
      change({ author: b, timestamp: 2000 }),
      change({ author: a, timestamp: 3000 }),
    ];
    expect(groupBy(cs, "author").map((g) => g.changes.length)).toEqual([2, 1, 1]);
    expect(groupBy(cs, "burst", 500).map((g) => g.changes.length)).toEqual([1, 1, 1, 1]);
  });
});

describe("subtreeScope + changesSince (integration over a doc + cut-log)", () => {
  function liveSetup() {
    const doc = new Y.Doc({ gc: false });
    const types = doc.getMap("types");
    const log = new InMemoryCutLog();
    doc.on("update", (_u, _o, _d, tr) => log.append(captureCut(tr, { seq: (log.latest()?.seq ?? -1) + 1, timestamp: Date.now(), author: null })));
    return { doc, types, log };
  }

  test("changesSince returns post-cursor changes + advances the cursor", () => {
    const { doc, types, log } = liveSetup();
    let btn!: Y.XmlElement;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
    });
    doc.transact(() => btn.setAttribute("fill", "red"));

    const all = changesSince(log, doc, -1);
    expect(all.changes.length).toBeGreaterThanOrEqual(2); // materialized + set
    expect(all.nextCursor).toBe(log.latest()?.seq);
    expect(changesSince(log, doc, all.nextCursor).changes).toHaveLength(0); // caught up
  });

  test("subtreeScope keeps only entities under a root (current tree)", () => {
    const { doc, types } = liveSetup();
    let card!: Y.XmlElement;
    let btn!: Y.XmlElement;
    doc.transact(() => {
      card = new Y.XmlElement("Card");
      types.set("c", card);
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
    });
    const uuidOf = (el: Y.XmlElement) => {
      const it = (el as unknown as { _item: { id: { client: number; clock: number } } })._item;
      return encodePlexusUUID(it.id.client, it.id.clock);
    };
    const cardUuid = uuidOf(card);
    doc.transact(() => btn.setAttribute(NUL, [cardUuid, "children"] as never));
    const btnUuid = uuidOf(btn);
    const changes = [change({ entity: { uuid: btnUuid, type: "Button" } })];
    expect(subtreeScope(changes, [cardUuid], doc)).toHaveLength(1); // btn is under card
    expect(subtreeScope(changes, ["nope"], doc)).toHaveLength(0);
  });
});
