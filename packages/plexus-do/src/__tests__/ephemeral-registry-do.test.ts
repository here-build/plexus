import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralRegistryDO } from "../presence/ephemeral-registry.js";
import { FakeCtx } from "./test-do-ctx.js";

interface Presence {
  lastSeen: number;
  name: string;
}

class ToyRegistryDO extends EphemeralRegistryDO<string, Presence> {
  protected entryExpiryMs = 1_000;
  protected alarmIdleMs = 500;
  protected isTestMode(): boolean {
    return true;
  }
}

function bootRegistry(): ToyRegistryDO {
  const ctx = new FakeCtx();
  return new ToyRegistryDO(ctx as unknown as DurableObjectState, {});
}

describe("EphemeralRegistryDO", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upsert stamps lastSeen and list returns live entries", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const reg = bootRegistry();
    reg.upsert("u1", { name: "a" });
    reg.upsert("u2", { name: "b" });
    nowSpy.mockReturnValue(100);
    expect(reg.list()).toHaveLength(2);
  });

  it("list() sweeps entries older than entryExpiryMs", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const reg = bootRegistry();
    reg.upsert("u1", { name: "a" }); // lastSeen = 0
    nowSpy.mockReturnValue(2_000); // 2000 - 0 > 1000 → expired
    expect(reg.list()).toHaveLength(0);
  });

  it("re-upsert refreshes lastSeen so the entry survives the sweep", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const reg = bootRegistry();
    reg.upsert("u1", { name: "a" });
    nowSpy.mockReturnValue(900);
    reg.upsert("u1", { name: "a" }); // refresh lastSeen = 900
    nowSpy.mockReturnValue(1_500); // 1500 - 900 < 1000 → still live
    expect(reg.list()).toHaveLength(1);
  });

  it("remove drops the entry", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const reg = bootRegistry();
    reg.upsert("u1", { name: "a" });
    reg.remove("u1");
    expect(reg.list()).toHaveLength(0);
  });
});
