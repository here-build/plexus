/**
 * Channel packing — the states-map key algebra.
 *
 * A states-map key is `base + channel * AWARENESS_CHANNEL_STRIDE`. Two
 * invariants must hold for every key the protocol can mint:
 *
 *   1. it is a SAFE integer — float64 represents consecutive integers only
 *      below 2^53; above it, `n` and `n + 1` can be the same value
 *   2. it round-trips — `parse(channelId(b, c))` gives back exactly `(b, c)`
 *
 * Break either and two users' lanes silently become one: no throw, no warning,
 * presence attributed to the wrong peer. These are the specification, not a
 * description of current behavior.
 *
 * The squeeze is that base and channel share one 53-bit budget. Plexus assigns
 * 51-bit bases (`Plexus.ts` overwrites `doc.clientID` with `newClientId()`),
 * which leaves 2 bits for the channel — so the ceiling is low and the failure
 * past it is silent rather than loud.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyAwarenessUpdate,
  AWARENESS_LANE_REGISTER,
  AWARENESS_MAX_LANES,
  awarenessChannelId,
  encodeAwarenessUpdate,
  PlexusAwareness,
} from "../../awareness.js";
import { newClientId } from "../../genesis-client.js";

/** The base range the constructor accepts (`isRegularClientId`). */
const MAX_BASE = AWARENESS_LANE_REGISTER - 1;

/** Lanes a realistic presence surface wants: cursor, selection, identity, meta, … */
const REALISTIC_FIELD_COUNT = 6;

describe("awareness channel packing", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  function make(clientId: number): PlexusAwareness {
    const doc = new Y.Doc();
    docs.push(doc);
    return new PlexusAwareness(doc, { clientId });
  }

  it("mints a safe integer for every legal base and lane", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_BASE }),
        fc.integer({ min: 0, max: AWARENESS_MAX_LANES }),
        (base, channel) => {
          expect(Number.isSafeInteger(awarenessChannelId(base, channel))).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("resolves every announced lane back to its own base", () => {
    const aw = make(newClientId());
    const fields = Array.from({ length: REALISTIC_FIELD_COUNT }, (_, i) => `f${i}`);
    for (const name of fields) aw.setField(name, name);

    const resolved = fields.map((_, i) => aw.resolveKey(awarenessChannelId(aw.clientID, i + 1)));
    expect(resolved).toEqual(fields.map((_, i) => ({ base: aw.clientID, lane: i + 1 })));
  });

  it("never maps two distinct bases to the same key on the same lane", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_BASE }),
        fc.integer({ min: 0, max: MAX_BASE }),
        fc.integer({ min: 0, max: REALISTIC_FIELD_COUNT }),
        (baseA, baseB, channel) => {
          fc.pre(baseA !== baseB);
          expect(awarenessChannelId(baseA, channel)).not.toBe(awarenessChannelId(baseB, channel));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("keeps every announced lane readable on one base", () => {
    const aw = make(newClientId());
    const fields = ["cursor", "selection", "identity", "meta", "viewport", "tool"];
    expect(fields.length).toBe(REALISTIC_FIELD_COUNT);

    for (const name of fields) aw.setField(name, `v-${name}`);

    const read = Object.fromEntries(fields.map((name) => [name, aw.getField(name)]));
    expect(read).toEqual(Object.fromEntries(fields.map((name) => [name, `v-${name}`])));
  });

  it("keeps two peers' lanes distinct in the states map", () => {
    const peerA = make(newClientId());
    const peerB = make(newClientId());
    const fields = ["cursor", "selection", "identity", "meta", "viewport", "tool"];

    for (const name of fields) {
      peerA.setField(name, `A-${name}`);
      peerB.setField(name, `B-${name}`);
    }

    const keys = [...peerA.states.keys(), ...peerB.states.keys()];
    expect(keys.filter((k) => !Number.isSafeInteger(k))).toEqual([]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * The consequence that actually reaches users.
 *
 * `fieldOfChannel` maps a `change` payload id back to (base, field) to decide
 * which atom to invalidate. It does that with `parseAwarenessChannelId`. Once a
 * key stops round-tripping, the lookup lands on a base that is not there, the
 * cell atom is never reported changed, and the lens goes quiet — no error, no
 * stale value, just a reaction that stops firing.
 */
describe("packing failure surfaces as lost reactivity", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  it("resolves every announced lane back to its field name", async () => {
    const { FieldAwareness } = await import("../../field-awareness.js");
    const doc = new Y.Doc();
    docs.push(doc);
    const aw = new PlexusAwareness(doc, { clientId: newClientId() });

    const fields = ["cursor", "selection", "identity", "meta", "viewport", "tool"];
    for (const name of fields) aw.setField(name, `v-${name}`);

    // Every field channel must be resolvable — this is what drives invalidation.
    const resolved = fields.map((name, i) => {
      const key = awarenessChannelId(aw.clientID, i + 1);
      return { name, resolvedTo: aw.fieldOfChannel(key)?.field ?? null };
    });
    expect(resolved).toEqual(fields.map((name) => ({ name, resolvedTo: name })));

    // And a lens on each must observe a write.
    const { autorun } = await import("mobx");
    for (const name of fields) {
      const lens = new FieldAwareness(aw, name);
      let fired = 0;
      const stop = autorun(() => {
        lens.get();
        fired++;
      });
      aw.setField(name, `changed-${name}`);
      stop();
      expect({ name, fired }).toEqual({ name, fired: 2 });
    }
  });
});

/**
 * Overlap is the one case the register scheme cannot make impossible: two bases
 * close enough that their DECLARED ranges cover the same key. It must resolve to
 * nobody rather than to the wrong peer — a missing update self-heals on the next
 * reconnect, a misattributed one shows a stranger's cursor as yours.
 */
describe("ambiguous lanes fail closed", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  function make(clientId: number): PlexusAwareness {
    const doc = new Y.Doc();
    docs.push(doc);
    return new PlexusAwareness(doc, { clientId });
  }

  it("resolves to null when two declared ranges cover one key", () => {
    // Deliberately adjacent bases: b and b+2, each announcing 4 lanes.
    const local = make(1_000_000);
    const a = make(500_000);
    const b = make(500_002);
    for (const aw of [a, b]) for (const n of ["p", "q", "r", "s"]) aw.setField(n, `${aw.clientID}-${n}`);

    for (const aw of [a, b]) {
      applyAwarenessUpdate(local, encodeAwarenessUpdate(aw, [...aw.states.keys()]), "remote");
    }

    // a's lane 3 and b's lane 1 are the same key — both ranges reach it.
    const contested = awarenessChannelId(a.clientID, 3);
    expect(contested).toBe(awarenessChannelId(b.clientID, 1));
    expect(local.resolveKey(contested)).toBeNull();
    expect(local.fieldOfChannel(contested)).toBeNull();

    // Lanes outside the overlap still resolve exactly.
    expect(local.resolveKey(awarenessChannelId(a.clientID, 1))).toEqual({ base: a.clientID, lane: 1 });
  });

  it("announcing past the lane ceiling throws instead of corrupting", () => {
    const aw = make(2_000_000);
    for (let i = 0; i < AWARENESS_MAX_LANES; i++) aw.setField(`f${i}`, i);
    expect(() => aw.setField("one-too-many", 1)).toThrow(/at most 64 lanes/);
  });
});
