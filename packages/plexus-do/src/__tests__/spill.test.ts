import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { ensureMidnightSpillAlarm, nextMidnightUtc, spillDocToR2, utcDayKey } from "../spill.js";
import { FakeStorage } from "./test-do-ctx.js";

describe("spill helpers", () => {
  it("formats UTC day keys for R2 object paths", () => {
    expect(utcDayKey(Date.parse("2026-07-01T15:30:00.000Z"))).toBe("2026-07-01");
  });

  it("schedules the next midnight UTC boundary", () => {
    const noon = Date.parse("2026-07-01T12:00:00.000Z");
    const midnight = nextMidnightUtc(noon);
    expect(new Date(midnight).toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("arms a midnight alarm once and does not move an existing one", async () => {
    const storage = new FakeStorage();
    const noon = Date.parse("2026-07-01T12:00:00.000Z");
    await ensureMidnightSpillAlarm(storage as unknown as DurableObjectStorage, false, noon);
    const first = await storage.getAlarm();
    expect(first).toBe(Date.parse("2026-07-02T00:00:00.000Z"));

    await ensureMidnightSpillAlarm(storage as unknown as DurableObjectStorage, false, Date.parse("2026-07-01T18:00:00.000Z"));
    expect(await storage.getAlarm()).toBe(first);
  });

  it("skips alarm arm in test mode", async () => {
    const storage = new FakeStorage();
    await ensureMidnightSpillAlarm(storage as unknown as DurableObjectStorage, true, Date.parse("2026-07-01T12:00:00.000Z"));
    expect(await storage.getAlarm()).toBeNull();
  });

  it("puts the full doc under the policy key and rejects an empty entity id", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("k", 1);
    const puts: { key: string; body: Uint8Array }[] = [];
    const bucket = {
      put: async (key: string, body: Uint8Array) => {
        puts.push({ key, body });
        return null;
      },
    };

    await spillDocToR2(doc, "proj-1", {
      bucket: bucket as unknown as R2Bucket,
      objectKey: (entityId, day) => `${entityId}/${day}`,
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^proj-1\/\d{4}-\d{2}-\d{2}$/);
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, puts[0]!.body);
    expect(decoded.getMap("root").get("k")).toBe(1);

    expect(() => {
      void spillDocToR2(doc, "", { bucket: bucket as unknown as R2Bucket, objectKey: (id, day) => `${id}/${day}` });
    }).toThrow(/entityId/);
  });
});