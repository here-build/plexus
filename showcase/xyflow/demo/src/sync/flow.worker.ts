import { YMessagePortProvider } from "@here.build/y-messageport";

import { defaultRoot } from "../seed.js";
import { DemoPlexus } from "./DemoPlexus.js";
import { fanOutPeerUpdates } from "./fanout.js";
import { DOC_GUID } from "./guid.js";

const PREFIX = "plexus-xyflow-flow:";
const workerName = (self as unknown as { name?: string }).name ?? "";
const room =
  workerName.startsWith(PREFIX) && workerName.slice(PREFIX.length)
    ? workerName.slice(PREFIX.length)
    : DOC_GUID;

const plexus = DemoPlexus.bootstrap(defaultRoot(), room);

const peers = new Set<YMessagePortProvider>();
fanOutPeerUpdates(plexus.doc, peers);

const scope = self as unknown as { onconnect: ((event: MessageEvent) => void) | null };

scope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  const provider = new YMessagePortProvider(plexus.doc, port, { awareness: plexus.awareness });
  peers.add(provider);
  const drop = () => {
    provider.destroy();
    peers.delete(provider);
  };
  port.addEventListener("close", drop);
  port.addEventListener("messageerror", drop);
};
