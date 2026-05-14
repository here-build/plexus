/**
 * MobX subpath reactivity for ControlChannel. Separate file so the prototype
 * patch doesn't bleed into the baseline suite.
 */
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";

import "../mobx.js";
import { ControlChannel } from "../ControlChannel.js";

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ControlChannel — mobx reactivity", () => {
  it("autorun re-fires when lastSeenMs advances via inbound message", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const seen: number[] = [];
    const dispose = autorun(() => {
      seen.push(a.lastSeenMs);
    });

    const initialCount = seen.length;
    await until(() => seen.length > initialCount);

    // Force another inbound by sending a status.
    const before = seen.length;
    b.postStatus("worker", "ready");
    await until(() => seen.length > before);

    expect(seen.length).toBeGreaterThan(initialCount);

    dispose();
    a.destroy();
    b.destroy();
  });
});
