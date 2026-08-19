import { PlexusModel, syncing } from "@here.build/plexus";
import type { Scene } from "./Scene.js";

/** Binary sidecar for an image. The element points; the file is registered on the Scene. */
@syncing("ExcalidrawFile")
export class ExcalidrawFile extends PlexusModel<Scene> {
  get fileId(): string | null {
    return this.parentFieldKey as string | null;
  }
  @syncing accessor mimeType = "image/png";
  @syncing accessor dataURL = "";
  @syncing accessor created = 0;
  @syncing accessor lastRetrieved: number | null = null;
}
