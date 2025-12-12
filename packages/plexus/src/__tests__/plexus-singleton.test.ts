import { describe, expect, it } from "vitest";
import { connectTestPlexus, initTestPlexus } from "./test-plexus.js";
import { PlexusModel } from "../PlexusModel.js";
import { syncing } from "../decorators.js";

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;
}

describe("Plexus singleton per Y.Doc", () => {
  it("allows multiple instances for the same document but shares dependencies", () => {
    const rootEntity = new Root({ name: "r" });
    const { doc, plexus: plexus1, root: root1 } = initTestPlexus<Root>(rootEntity);

    // Second instance should be allowed but will share dependency mappings
    const { plexus: plexus2, root: root2 } = connectTestPlexus<Root>(doc);

    // Both should exist
    expect(plexus1).toBeDefined();
    expect(plexus2).toBeDefined();

    // They are different instances
    expect(plexus1).toBe(plexus2);

    // But they share the same doc
    expect(plexus2.doc).toBe(doc);

    // Both should return the exact same root entity instance
    expect(root2).toBe(root1);
  });
});
