import { XyflowAwareness, XyflowPlexus } from "@here.build/plexus-xyflow/plexus";

import { boringAvatar } from "./avatar.js";

export class DemoAwareness extends XyflowAwareness {
  getAvatar(clientId: number): string {
    const hue = this.hueFor(clientId);
    const fill = this.fillForHue(hue);
    return boringAvatar(String(clientId), [
      fill,
      `oklch(0.72 var(--presence-chroma) ${hue})`,
      `oklch(0.92 0.04 ${hue})`,
      `oklch(0.55 0.1 ${hue})`,
      `oklch(0.28 0.06 ${hue})`,
    ]);
  }
}

export class DemoPlexus extends XyflowPlexus {
  override awareness = new DemoAwareness(this.doc);
}
