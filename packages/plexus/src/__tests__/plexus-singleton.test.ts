import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TestPlexus, initTestPlexus } from "./test-plexus";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;

  constructor(props) {
    super(props);
  }
}

describe("Plexus singleton per Y.Doc", () => {
  it("throws if constructed twice for the same document", async () => {
    const rootEntity = new Root({ name: "r" });
    const { doc } = await initTestPlexus<Root>(rootEntity);

    // Second instance should fail immediately on constructor
    expect(() => new TestPlexus<any>(doc)).toThrow();
  });
});
