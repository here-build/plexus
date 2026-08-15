import { describe, expect, it } from "vitest";

import { nextMidnightUtc, utcDayKey } from "../spill.js";

describe("spill helpers", () => {
  it("formats UTC day keys for R2 object paths", () => {
    expect(utcDayKey(Date.parse("2026-07-01T15:30:00.000Z"))).toBe("2026-07-01");
  });

  it("schedules the next midnight UTC boundary", () => {
    const noon = Date.parse("2026-07-01T12:00:00.000Z");
    const midnight = nextMidnightUtc(noon);
    expect(new Date(midnight).toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });
});