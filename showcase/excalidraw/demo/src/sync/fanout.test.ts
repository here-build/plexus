import { YMessagePortProviderOrigin } from "@here.build/y-messageport";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { fanOutPeerUpdates } from "./fanout.js";

function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

describe("fanOutPeerUpdates", () => {
  it("forwards only updates tagged with the provider origin", async () => {
    const hub = new Y.Doc();
    const a = new MessageChannel();
    const b = new MessageChannel();
    const stop = fanOutPeerUpdates(hub, new Set([{ port: a.port1 }, { port: b.port1 }]));

    const first = Promise.all([nextMessage(a.port2), nextMessage(b.port2)]);
    hub.transact(() => {
      hub.getMap("t").set("k", 1);
    }, YMessagePortProviderOrigin);
    const frames = await first;
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBeInstanceOf(Uint8Array);
    expect(frames[1]).toBeInstanceOf(Uint8Array);

    let stray = 0;
    a.port2.onmessage = () => {
      stray += 1;
    };
    b.port2.onmessage = () => {
      stray += 1;
    };
    hub.transact(() => {
      hub.getMap("t").set("k", 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stray).toBe(0);

    stop();
    a.port1.close();
    a.port2.close();
    b.port1.close();
    b.port2.close();
    hub.destroy();
  });
});
