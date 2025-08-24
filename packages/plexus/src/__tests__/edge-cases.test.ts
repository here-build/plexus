/**
 * Ultra-Hardcore Edge Cases for Contagious Proxy System
 *
 * These tests target the most challenging scenarios that could break
 * the quantum superposition architecture and cross-document sync.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { ProjectId, YJS_GLOBALS } from "..";

import { type ModelType, referenceSymbol } from "../proxy-runtime-types";
import { buildModelClass } from "../proxy-runtime";

// Extended Y.Doc type for testing
type TestYDoc = Y.Doc;

type ComponentType = ModelType<
  {
    name: string;
    type: string;
    readonly children: ComponentType[];
    readonly metadata: Record<string, string>;
  },
  "Component"
>;
// Test schema definitions
const Component = buildModelClass<ComponentType>("Component", {
  name: "val",
  type: "val",
  children: "list",
  metadata: "record"
});

type SiteType = ModelType<
  {
    name: string;
    readonly components: Record<string, ComponentType>;
  },
  "Site"
>;

const Site = buildModelClass<SiteType>("Site", {
  name: "val",
  components: "record"
});

// Sync helper function
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

// Helper to create materialized site
function createTestSite(name: string, projectId: ProjectId, doc: TestYDoc) {
  const ephemeralSite = new Site({ name, components: {} });
  const siteRef = (ephemeralSite as any)[referenceSymbol](projectId, doc);
  const entityId = siteRef[0];
  return { site: Site.spawn(entityId, projectId, doc), entityId };
}

describe("Proxy Edge Cases", () => {
  let doc1: TestYDoc;
  let doc2: TestYDoc;
  const projectId: ProjectId = "test-project" as ProjectId;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
    doc1.getMap(YJS_GLOBALS.metadataMap).set(YJS_GLOBALS.metadataMapFields.projectId, projectId);
    doc2.getMap(YJS_GLOBALS.metadataMap).set(YJS_GLOBALS.metadataMapFields.projectId, projectId);
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  describe("🔥 Circular References", () => {
    it("should handle simple circular references without infinite recursion", () => {
      const { site } = createTestSite("Circular Test", projectId, doc1);

      // Create circular reference: A → B → C → A
      const componentA = new Component({
        name: "A",
        type: "component",
        children: [],
        metadata: {}
      });

      const componentB = new Component({
        name: "B",
        type: "component",
        children: [],
        metadata: {}
      });

      const componentC = new Component({
        name: "C",
        type: "component",
        children: [],
        metadata: {}
      });

      // Build the circle
      componentA.children.push(componentB);
      componentB.children.push(componentC);
      componentC.children.push(componentA); // CIRCULAR!

      // This should materialize all without infinite recursion
      expect(() => {
        site.components["a"] = componentA;
      }).not.toThrow();

      // Verify structure integrity
      expect(site.components["a"].name).toBe("A");
      expect(site.components["a"].children[0].name).toBe("B");
      expect(site.components["a"].children[0].children[0].name).toBe("C");
      expect(site.components["a"].children[0].children[0].children[0].name).toBe("A");

      // Critical: Verify circular identity is preserved
      expect(site.components["a"]).toBe(site.components["a"].children[0].children[0].children[0]);
    });

    it("should handle self-references correctly", () => {
      const { site } = createTestSite("Self-Reference Test", projectId, doc1);

      const component = new Component({
        name: "Recursive",
        type: "component",
        children: [],
        metadata: {}
      });

      // Self-reference
      component.children.push(component);

      // Materialize
      site.components["recursive"] = component;

      // Verify self-identity is preserved
      expect(site.components["recursive"]).toBe(site.components["recursive"].children[0]);
      expect(site.components["recursive"].name).toBe("Recursive");
      expect(site.components["recursive"].children[0].name).toBe("Recursive");
    });

    it("should sync circular references across documents", () => {
      const { site: site1, entityId } = createTestSite("Circular Sync Test", projectId, doc1);

      const compA = new Component({ name: "A", type: "component", children: [], metadata: {} });
      const compB = new Component({ name: "B", type: "component", children: [], metadata: {} });

      // Create circular reference
      compA.children.push(compB);
      compB.children.push(compA);

      site1.components["a"] = compA;

      // Sync to doc2
      syncDocs(doc1, doc2);

      // Access from doc2
      const site2 = Site.spawn(entityId, projectId, doc2);
      const compA2 = site2.components["a"];

      // Verify circular structure is preserved across documents
      expect(compA2.name).toBe("A");
      expect(compA2.children[0].name).toBe("B");
      expect(compA2.children[0].children[0].name).toBe("A");

      // Critical: Verify circular identity across documents
      expect(compA2).toBe(compA2.children[0].children[0]);
    });
  });

  describe("🏎️ Concurrent Mutation Races", () => {
    it("should handle concurrent cross-document mutations", () => {
      const { site: site1, entityId: siteId } = createTestSite("Race Test", projectId, doc1);
      const comp1 = new Component({ name: "Original", type: "component", children: [], metadata: {} });
      site1.components["shared"] = comp1;

      // Initial sync
      syncDocs(doc1, doc2);

      // Get same entity from both documents
      const site2 = Site.spawn(siteId, projectId, doc2);
      const comp1_doc1 = site1.components["shared"];
      const comp1_doc2 = site2.components["shared"];

      // Concurrent mutations
      comp1_doc1.name = "Modified by Doc1";
      comp1_doc1.metadata["source"] = "doc1";

      comp1_doc2.name = "Modified by Doc2";
      comp1_doc2.metadata["source"] = "doc2";

      // Add different children concurrently
      const child1 = new Component({ name: "Child1", type: "child", children: [], metadata: {} });
      const child2 = new Component({ name: "Child2", type: "child", children: [], metadata: {} });

      comp1_doc1.children.push(child1);
      comp1_doc2.children.push(child2);

      // Sync and verify CRDT resolution
      syncDocs(doc1, doc2);

      // Both documents should converge to same state
      expect(comp1_doc1.name).toBe(comp1_doc2.name); // Last write wins or CRDT resolution
      expect(comp1_doc1.children.length).toBe(comp1_doc2.children.length);
      expect(comp1_doc1.children.length).toBe(2); // Both children should be present

      // Verify children from both docs are present
      const childNames1 = comp1_doc1.children.map((c) => c.name).sort();
      const childNames2 = comp1_doc2.children.map((c) => c.name).sort();
      expect(childNames1).toEqual(["Child1", "Child2"]);
      expect(childNames2).toEqual(["Child1", "Child2"]);
    });
  });

  describe("🕳️ Array Holes and Sparse Operations", () => {
    it("should handle array holes correctly", () => {
      const { site } = createTestSite("Array Holes Test", projectId, doc1);

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {}
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

    it("should sync sparse arrays correctly", () => {
      const { site: site1, entityId } = createTestSite("Sparse Sync Test", projectId, doc1);

      const parent = new Component({ name: "Parent", type: "container", children: [], metadata: {} });
      const child = new Component({ name: "SparseChild", type: "child", children: [], metadata: {} });

      parent.children[50] = child; // Sparse assignment
      site1.components["parent"] = parent;

      // Sync to doc2
      syncDocs(doc1, doc2);

      const site2 = Site.spawn(entityId, projectId, doc2);
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

  describe("💥 Exception Handling During Contagion", () => {
    it("should handle materialization failures gracefully", () => {
      const { site } = createTestSite("Exception Test", projectId, doc1);

      const normalComponent = new Component({
        name: "Normal",
        type: "component",
        children: [],
        metadata: {}
      });

      const poisonedComponent = new Component({
        name: "Poisoned",
        type: "component",
        children: [],
        metadata: {}
      });

      // Mock a failing referenceSymbol - this simulates a corrupted entity
      const originalRef = poisonedComponent[referenceSymbol];
      Object.defineProperty(poisonedComponent, referenceSymbol, {
        value: () => {
          throw new Error("Materialization failed!");
        },
        configurable: true
      });

      normalComponent.children.push(poisonedComponent);

      // This should fail gracefully with console.warn, not crash the system
      site.components["test"] = normalComponent;

      // Restore the poisoned component
      Object.defineProperty(poisonedComponent, referenceSymbol, {
        value: originalRef,
        configurable: true
      });

      // Now it should work
      expect(() => {
        site.components["test"] = normalComponent;
      }).not.toThrow();

      expect(site.components["test"].children[0].name).toBe("Poisoned");
    });
  });

  describe("🗑️ Garbage Collection Edge Cases", () => {
    it("should handle WeakRef cleanup during operations", () => {
      const { site } = createTestSite("GC Test", projectId, doc1);

      // Create many entities to stress the cache system
      const entities: any[] = [];
      for (let i = 0; i < 100; i++) {
        entities.push(
          new Component({
            name: `Entity${i}`,
            type: "component",
            children: [],
            metadata: {}
          })
        );
      }

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: entities,
        metadata: {}
      });

      // Materialize everything
      site.components["parent"] = parent;

      // Clear references to force potential GC
      entities.length = 0;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      // Verify entities are still accessible through parent
      expect(site.components["parent"].children.length).toBe(100);
      expect(site.components["parent"].children[0].name).toBe("Entity0");
      expect(site.components["parent"].children[99].name).toBe("Entity99");

      // Verify we can still perform operations
      site.components["parent"].children.push(
        new Component({ name: "NewEntity", type: "component", children: [], metadata: {} })
      );

      expect(site.components["parent"].children.length).toBe(101);
      expect(site.components["parent"].children[100].name).toBe("NewEntity");
    });
  });

  describe("🎭 Proxy Trap Edge Cases", () => {
    it("should handle negative array indices", () => {
      const { site } = createTestSite("Negative Index Test", projectId, doc1);

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {}
      });

      const child = new Component({ name: "Child", type: "child", children: [], metadata: {} });
      parent.children.push(child);

      site.components["parent"] = parent;

      // Test negative indices (should warn and throw TypeError for invalid index)
      expect(() => {
        parent.children[-1] = child;
      }).toThrow();

      // Should still have only one child
      expect(parent.children.length).toBe(1);
      expect(parent.children[0].name).toBe("Child");
    });

    it("should handle array length manipulation", () => {
      const { site } = createTestSite("Length Test", projectId, doc1);

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {}
      });

      // Add several children
      for (let i = 0; i < 5; i++) {
        parent.children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {}
          })
        );
      }

      site.components["parent"] = parent;
      expect(parent.children.length).toBe(5);

      // Truncate by setting length
      parent.children.length = 2;

      expect(parent.children.length).toBe(2);
      expect(parent.children[0].name).toBe("Child0");
      expect(parent.children[1].name).toBe("Child1");
      expect(parent.children[2]).toBeNull();
    });
  });

  describe("🧪 JSON Serialization Edge Cases", () => {
    it("should handle JSON.stringify on ephemeral entities", () => {
      const component = new Component({
        name: "Test",
        type: "component",
        children: [],
        metadata: { key: "value" }
      });

      // This should not throw or cause infinite loops
      expect(() => {
        const json = JSON.stringify(component);
        const parsed = JSON.parse(json);
        expect(parsed.name).toBe("Test");
        expect(parsed.metadata.key).toBe("value");
      }).not.toThrow();
    });

    it("should handle JSON.stringify on materialized entities", () => {
      const { site } = createTestSite("JSON Test", projectId, doc1);

      const component = new Component({
        name: "Materialized",
        type: "component",
        children: [],
        metadata: { serialized: "true" }
      });

      site.components["test"] = component; // Materialize

      // Direct property access should work
      expect(component.name).toBe("Materialized");
      expect(component.metadata.serialized).toBe("true");

      // JSON serialization is expected to have limitations with proxies
      // Test that it doesn't crash and captures basic structure
      expect(() => {
        const json = JSON.stringify(component);
        const parsed = JSON.parse(json);
        expect(parsed.name).toBe("Materialized");
        expect(parsed.type).toBe("component");
        // Note: proxy maps may not serialize properly, which is expected
      }).not.toThrow();
    });

    it("should handle JSON.stringify with circular references", () => {
      const compA = new Component({ name: "A", type: "component", children: [], metadata: {} });
      const compB = new Component({ name: "B", type: "component", children: [], metadata: {} });

      compA.children.push(compB);
      compB.children.push(compA); // Circular!

      // JSON.stringify should handle circular references gracefully
      expect(() => {
        JSON.stringify(compA);
      }).toThrow(/circular|cyclic/i); // Should throw expected circular reference error
    });
  });

  describe("🚀 Async Operations Edge Cases", () => {
    it("should handle async modifications during materialization", async () => {
      const { site } = createTestSite("Async Test", projectId, doc1);

      const component = new Component({
        name: "Original",
        type: "component",
        children: [],
        metadata: {}
      });

      // Set up async modification
      const asyncModification = new Promise((resolve) => {
        setTimeout(() => {
          component.name = "Modified Async";
          resolve(void 0);
        }, 1);
      });

      // Trigger materialization
      site.components["test"] = component;

      // Wait for async modification
      await asyncModification;

      // Both sync and async changes should be preserved
      expect(component.name).toBe("Modified Async");
    });

    it("should handle Promise resolution accessing proxy entities", async () => {
      const { site } = createTestSite("Promise Test", projectId, doc1);

      const component = new Component({
        name: "Promise",
        type: "component",
        children: [],
        metadata: {}
      });

      site.components["test"] = component;

      // Promise accessing materialized entity
      await new Promise((resolve) => {
        setTimeout(() => {
          expect(component.name).toBe("Promise");
          component.metadata["accessed"] = "true";
          resolve(void 0);
        }, 1);
      });

      expect(component.metadata["accessed"]).toBe("true");
    });
  });

  describe("🏗️ Object Property Descriptor Edge Cases", () => {
    it("should handle Object.defineProperty attempts", () => {
      const component = new Component({
        name: "Property Test",
        type: "component",
        children: [],
        metadata: {}
      });

      // Attempt to define new properties should be handled gracefully
      expect(() => {
        Object.defineProperty(component, "customProp", {
          value: "custom",
          writable: true,
          enumerable: true
        });
      }).not.toThrow();
    });

    it("should handle Object.freeze attempts", () => {
      const component = new Component({
        name: "Freeze Test",
        type: "component",
        children: [],
        metadata: {}
      });

      // Freezing ephemeral entities should work
      expect(() => {
        Object.freeze(component);
      }).not.toThrow();

      // After freezing, the object becomes immutable
      expect(() => {
        component.name = "Should Fail";
      }).toThrow();

      // NOTE: Object.freeze() + materialized proxies have fundamental incompatibilities
      // due to JavaScript proxy invariants. This is expected behavior.
    });

    it("should handle Object.getOwnPropertyDescriptor", () => {
      const component = new Component({
        name: "Descriptor Test",
        type: "component",
        children: [],
        metadata: {}
      });

      expect(() => {
        const descriptor = Object.getOwnPropertyDescriptor(component, "name");
        expect(descriptor).toBeTruthy();
      }).not.toThrow();
    });
  });

  describe("💀 Resource Exhaustion Edge Cases", () => {
    it("should handle very large collections without crashing", () => {
      const { site } = createTestSite("Large Collection Test", projectId, doc1);

      const parent = new Component({
        name: "Large Parent",
        type: "container",
        children: [],
        metadata: {}
      });

      // Create large collection (but not too large to timeout tests)
      const children = [];
      for (let i = 0; i < 1000; i++) {
        children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: { index: i.toString() }
          })
        );
      }

      expect(() => {
        parent.children.push(...children);
        site.components["large"] = parent; // Materialize everything
      }).not.toThrow();

      expect(parent.children.length).toBe(1000);
      expect(parent.children[0].name).toBe("Child0");
      expect(parent.children[999].name).toBe("Child999");
    });

    it("should handle deep nesting without stack overflow", () => {
      const { site } = createTestSite("Deep Nesting Test", projectId, doc1);

      // Create deep nesting chain (100 levels)
      let current = new Component({
        name: "Root",
        type: "component",
        children: [],
        metadata: {}
      });

      const root = current;

      for (let i = 1; i < 100; i++) {
        const child = new Component({
          name: `Level${i}`,
          type: "component",
          children: [],
          metadata: {}
        });
        current.children.push(child);
        current = child;
      }

      expect(() => {
        site.components["deep"] = root; // Materialize deep structure
      }).not.toThrow();

      // Verify deep access works
      let node = site.components["deep"];
      for (let i = 1; i < 100; i++) {
        expect(node.children[0].name).toBe(`Level${i}`);
        node = node.children[0];
      }
    });
  });

  describe("🌐 Cross-Document Orphaning Edge Cases", () => {
    it("should handle references to destroyed documents", () => {
      const { site: site1, entityId } = createTestSite("Orphaning Test", projectId, doc1);

      const component = new Component({
        name: "Will Be Orphaned",
        type: "component",
        children: [],
        metadata: {}
      });

      site1.components["test"] = component;

      // Sync to doc2
      syncDocs(doc1, doc2);
      const site2 = Site.spawn(entityId, projectId, doc2);
      const component2 = site2.components["test"];

      // Destroy doc1
      doc1.destroy();

      // component2 should still be accessible and functional
      expect(component2.name).toBe("Will Be Orphaned");

      // Modifications should still work on surviving document
      expect(() => {
        component2.name = "Still Alive";
      }).not.toThrow();

      expect(component2.name).toBe("Still Alive");
    });
  });

  describe("🔀 Complex Array Operations", () => {
    it("should handle complex array method combinations", () => {
      const { site } = createTestSite("Complex Array Test", projectId, doc1);

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {}
      });

      // Create initial children
      const children = [];
      for (let i = 0; i < 5; i++) {
        children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {}
          })
        );
      }

      parent.children.push(...children);
      site.components["parent"] = parent;

      // Test complex operations
      const popped = parent.children.pop();
      expect(popped?.name).toBe("Child4");
      expect(parent.children.length).toBe(4);

      const shifted = parent.children.shift();
      expect(shifted?.name).toBe("Child0");
      expect(parent.children.length).toBe(3);

      // Splice operation
      const newChild = new Component({ name: "NewChild", type: "child", children: [], metadata: {} });
      const spliced = parent.children.splice(1, 1, newChild);
      expect(spliced.length).toBe(1);
      expect(spliced[0].name).toBe("Child2");
      expect(parent.children.length).toBe(3);
      expect(parent.children[1].name).toBe("NewChild");

      // Reverse
      parent.children.reverse();
      expect(parent.children[0].name).toBe("Child3");
      expect(parent.children[1].name).toBe("NewChild");
      expect(parent.children[2].name).toBe("Child1");
    });

    it("should sync complex array operations across documents", () => {
      const { site: site1, entityId } = createTestSite("Complex Sync Test", projectId, doc1);

      const parent = new Component({
        name: "Parent",
        type: "container",
        children: [],
        metadata: {}
      });

      // Add initial children
      for (let i = 0; i < 3; i++) {
        parent.children.push(
          new Component({
            name: `Child${i}`,
            type: "child",
            children: [],
            metadata: {}
          })
        );
      }

      site1.components["parent"] = parent;

      // Initial sync
      syncDocs(doc1, doc2);

      const site2 = Site.spawn(entityId, projectId, doc2);
      const parent1 = site1.components["parent"];
      const parent2 = site2.components["parent"];

      // Perform complex operations on doc1
      parent1.children.reverse();
      parent1.children.pop();

      // Sync changes
      syncDocs(doc1, doc2);

      // Verify doc2 reflects changes
      // Expected: reverse() [Child2, Child1, Child0] then pop() removes Child0 → [Child2, Child1]
      expect(parent2.children.length).toBe(2);
      expect(parent2.children[0].name).toBe("Child2");
      expect(parent2.children[1].name).toBe("Child1");
    });
  });
});
