import { Plexus } from "@here.build/plexus";
import { Flow } from "@here.build/plexus-xyflow-models";

import { XyflowAwareness } from "./XyflowAwareness.js";

export {
  XyflowAwareness,
  PRESENCE_CURSOR_FIELD,
  PRESENCE_NAME_FIELD,
  PRESENCE_SELECTION_FIELD,
  type PresenceAwarenessShape,
} from "./XyflowAwareness.js";

export class XyflowPlexus extends Plexus<Flow> {
  override awareness = new XyflowAwareness(this.doc);
}
