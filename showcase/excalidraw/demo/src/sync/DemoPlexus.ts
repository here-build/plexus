import { ExcalidrawAwareness, ExcalidrawPlexus } from "@here.build/plexus-excalidraw/plexus";

import { boringAvatar } from "./avatar.js";

/** Demo faces. Identity and hue stay on {@link ExcalidrawAwareness}. */
export class DemoAwareness extends ExcalidrawAwareness {
  getAvatar(clientId: number): string {
    return boringAvatar(clientId.toString());
  }
}

export class DemoPlexus extends ExcalidrawPlexus {
  override awareness = new DemoAwareness(this.doc);
}
