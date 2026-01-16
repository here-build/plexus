/**
 * Sparse Arrays Test
 *
 * Tests for array holes and sparse array operations in the Plexus proxy system.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";
import { primeDoc } from "../_helpers/test-helpers.js";

// Test schema definitions
@syncing
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor type!: string;

  @syncing.list
  accessor children: Component[] = [];

  @syncing.record
  accessor metadata: Record<string, string> = {};
}

@syncing
class Site extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.record
  accessor components!: Record<string, Component>;
}

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// Helper to create materialized site as root
async function createTestSite(name: string): Promise<{ site: Site; entityId: string; doc: Y.Doc }> {
  const ephemeralSite = new Site({ name, components: {} });
  const { doc, root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

describe("Array Holes and Sparse Operations", () => {
  let doc1: Y.Doc;
  let doc2: Y.Doc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
    primeDoc(doc1);
    primeDoc(doc2);
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  it("should handle array holes correctly", async () => {
    const { site } = await createTestSite("Array Holes Test");

    const parent = new Component({
      name: "Parent",
      type: "container",
      children: [],
      metadata: {},
    });

    const child1 = new Component({ name: "Child1", type: "child", children: [], metadata: {} });
    const child2 = new Component({ name: "Child100", type: "child", children: [], metadata: {} });

    // Create sparse array with holes
    parent.children[0] = child1;
    parent.children[100] = child2;

    site.components["parent"] = parent;

    // Verify sparse array structure
    expect(parent.children.length).toBe(101);
    expect(parent.children[0].name).toBe("Child1");
    expect(parent.children[100].name).toBe("Child100");

    // Holes should be null or undefined
    for (let i = 1; i < 100; i++) {
      expect(parent.children[i]).toBeNull();
    }
  });

  it("should sync sparse arrays correctly", async () => {
    const { site: site1, doc: doc1 } = await createTestSite("Sparse Sync Test");

    const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
    parent.children[50] = new Component({ name: "SparseChild", type: "child", children: [], metadata: {} }); // Sparse assignment
    site1.components["parent"] = parent;

    // Sync to doc2
    syncDocs(doc1, doc2);

    const { root: site2 } = connectTestPlexus<Site>(doc2);
    const parent2 = site2.components["parent"];

    // Verify sparse structure is preserved
    expect(parent2.children.length).toBe(51);
    expect(parent2.children[50].name).toBe("SparseChild");

    // Verify holes are preserved
    for (let i = 0; i < 50; i++) {
      expect(parent2.children[i]).toBeNull();
    }
  });
});
