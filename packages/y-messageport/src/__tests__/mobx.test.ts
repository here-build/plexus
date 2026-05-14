/**
 * MobX subpath reactivity test. Side-effect import patches the prototype
 * getters globally — kept in a separate file so vitest's per-file isolation
 * prevents pollution of the baseline sync suite.
 */
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import "../mobx.js";
import { YMessagePortProvider } from "../YMessagePortProvider.js";

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("YMessagePortProvider — mobx reactivity", () => {
  it("autorun re-fires when synced flips", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    const seen: boolean[] = [];
    const dispose = autorun(() => {
      seen.push(provA.synced);
    });

    await until(() => seen.includes(true));
    expect(seen[0]).toBe(false);
    expect(seen[seen.length - 1]).toBe(true);

    dispose();
    provA.destroy();
    provB.destroy();
  });

  it("autorun re-fires when status changes", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    const seen: string[] = [];
    const dispose = autorun(() => {
      seen.push(provA.status);
    });

    await until(() => seen.includes("connected"));
    expect(seen[0]).toBe("connecting");

    provA.destroy();
    await until(() => seen.includes("disconnected"));

    dispose();
    provB.destroy();
  });
});
