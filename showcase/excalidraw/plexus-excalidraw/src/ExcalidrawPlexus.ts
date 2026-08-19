/**
 * Plexus specialized for an Excalidraw Scene.
 *
 * Same instance interface as Plexus — `root`, `doc`, `awareness`, `undo`.
 * Extend this class for host-specific awareness (auth identity, richer faces).
 * Swap the strategy by constructing a subclass as `awareness`.
 *
 * Warmup is still pre-plexus: sync the Y.Doc, then
 * `ExcalidrawPlexus.connect(doc)` or `ExcalidrawPlexus.bootstrap(scene, guid, doc)`.
 *
 * Importing this module imports `Scene`. `Scene.createElement` constructs
 * every document type, so those classes load and `@syncing` registers them.
 */

import { Plexus } from "@here.build/plexus";
import { Scene } from "@here.build/plexus-excalidraw-models";

import { ExcalidrawAwareness } from "./ExcalidrawAwareness.js";

export {
  ExcalidrawAwareness,
  PRESENCE_CURSOR_FIELD,
  PRESENCE_NAME_FIELD,
  PRESENCE_SELECTION_FIELD,
  type PresenceAwarenessShape,
} from "./ExcalidrawAwareness.js";

export class ExcalidrawPlexus extends Plexus<Scene> {
  override awareness = new ExcalidrawAwareness(this.doc);
}
