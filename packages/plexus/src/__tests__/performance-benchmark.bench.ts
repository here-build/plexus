/**
 * Comprehensive Performance Benchmark: Plexus vs MobX
 *
 * This test suite provides deep performance analysis comparing:
 * - Object creation (ephemeral vs materialized vs MobX observable)
 * - Property access patterns (simple, nested, collections)
 * - Mutation performance (updates, arrays, maps, batching)
 * - Reactivity systems (tracking setup, notifications, multiple observers)
 * - Memory patterns and GC behavior
 * - Complex scenarios (deep hierarchies, large datasets, collaborative sync)
 * - YJS-specific CRDT operations
 */

import { bench, describe } from 'vitest';
import { observable, autorun, runInAction, configure } from 'mobx';
import * as Y from 'yjs';
import { buildModelClass, type ProjectId } from '../proxy-runtime.js';
import { createTrackedFunction } from '../tracking.js';
import type { ModelType } from '../proxy-runtime-types.js';

// Configure MobX for optimal performance
configure({
  enforceActions: "never",
  computedRequiresReaction: false,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
  disableErrorBoundaries: true
});

// Test schemas and types
type SimpleModel = ModelType<{
  name: string;
  count: number;
  enabled: boolean;
}, "SimpleModel">;

type ComplexModel = ModelType<{
  id: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly tags: string[];
  nested: SimpleModel;
}, "ComplexModel">;

type LargeModel = ModelType<{
  readonly items: SimpleModel[];
  readonly lookup: Record<string, SimpleModel>;
  readonly counters: Record<string, number>;
}, "LargeModel">;

// Model classes
const SimpleModelClass = buildModelClass<SimpleModel>("SimpleModel", {
  name: "val",
  count: "val",
  enabled: "val"
});

const ComplexModelClass = buildModelClass<ComplexModel>("ComplexModel", {
  id: "val",
  metadata: "map",
  tags: "list",
  nested: "val"
});

const LargeModelClass = buildModelClass<LargeModel>("LargeModel", {
  items: "list",
  lookup: "map",
  counters: "map"
});

// Helper to create YJS document setup
function createYJSSetup() {
  const doc = new Y.Doc() as any;
  doc.rootProjectId = "test-project";
  return { doc, projectId: "test-project" as ProjectId };
}

// Helper to create MobX observable objects
function createMobXSimple() {
  return observable({
    name: "test",
    count: 0,
    enabled: true
  });
}

function createMobXComplex() {
  return observable({
    id: "test-id",
    metadata: observable.map(),
    tags: observable.array(),
    nested: createMobXSimple()
  });
}

describe('Object Creation Performance', () => {
  bench('Plexus: Ephemeral object creation', () => {
    const obj = new SimpleModelClass({
      name: "test",
      count: 42,
      enabled: true
    });
    // Touch the object to ensure it's created
    void obj.name;
  });

  bench('Plexus: Materialized object creation', () => {
    const { doc, projectId } = createYJSSetup();
    const obj = new SimpleModelClass({
      name: "test",
      count: 42,
      enabled: true
    });
    // Materialize by referencing
    const ref = obj[Symbol.for("reference")](projectId, doc);
    void ref;
  });

  bench('MobX: Observable object creation', () => {
    const obj = createMobXSimple();
    void obj.name;
  });

  bench('Plexus: Complex object creation (ephemeral)', () => {
    const nested = new SimpleModelClass({
      name: "nested",
      count: 1,
      enabled: false
    });

    const obj = new ComplexModelClass({
      id: "complex-test",
      metadata: {},
      tags: [],
      nested
    });
    void obj.id;
  });

  bench('MobX: Complex object creation', () => {
    const obj = createMobXComplex();
    void obj.id;
  });
});

describe('Property Access Performance', () => {
  const plexusSimple = new SimpleModelClass({
    name: "test",
    count: 42,
    enabled: true
  });

  const mobxSimple = createMobXSimple();

  bench('Plexus: Simple property access', () => {
    const name = plexusSimple.name;
    const count = plexusSimple.count;
    const enabled = plexusSimple.enabled;
    void name; void count; void enabled;
  });

  bench('MobX: Simple property access', () => {
    const name = mobxSimple.name;
    const count = mobxSimple.count;
    const enabled = mobxSimple.enabled;
    void name; void count; void enabled;
  });

  // Complex nested access
  const plexusNested = new ComplexModelClass({
    id: "test",
    metadata: { key1: "value1", key2: "value2" },
    tags: ["tag1", "tag2", "tag3"],
    nested: new SimpleModelClass({
      name: "nested",
      count: 10,
      enabled: true
    })
  });

  const mobxNested = observable({
    id: "test",
    metadata: observable.map([["key1", "value1"], ["key2", "value2"]]),
    tags: observable.array(["tag1", "tag2", "tag3"]),
    nested: createMobXSimple()
  });

  bench('Plexus: Nested property access', () => {
    const id = plexusNested.id;
    const key1 = plexusNested.metadata["key1"];
    const firstTag = plexusNested.tags[0];
    const nestedName = plexusNested.nested?.name;
    void id; void key1; void firstTag; void nestedName;
  });

  bench('MobX: Nested property access', () => {
    const id = mobxNested.id;
    const key1 = mobxNested.metadata.get("key1");
    const firstTag = mobxNested.tags[0];
    const nestedName = mobxNested.nested?.name;
    void id; void key1; void firstTag; void nestedName;
  });

  // Test ephemeral objects within tracking context
  bench('Plexus: Ephemeral property access (tracked)', () => {
    // Create ephemeral objects (never materialized)
    const ephemeralObj = new SimpleModelClass({
      name: "ephemeral",
      count: 42,
      enabled: true
    });

    const trackedFn = createTrackedFunction(() => {
      // Tracking callback (not called in bench)
    }, () => {
      const name = ephemeralObj.name;
      const count = ephemeralObj.count;
      const enabled = ephemeralObj.enabled;
      void name; void count; void enabled;
      return name + count;
    });

    trackedFn();
  });

  bench('MobX: Property access (tracked)', () => {
    const mobxObj = createMobXSimple();

    const dispose = autorun(() => {
      const name = mobxObj.name;
      const count = mobxObj.count;
      const enabled = mobxObj.enabled;
      void name; void count; void enabled;
      return name + count;
    });

    dispose();
  });

  // Test ephemeral vs materialized property access
  bench('Plexus: Ephemeral property access (untracked)', () => {
    // Pure ephemeral - no YJS involvement
    const ephemeralObj = new SimpleModelClass({
      name: "ephemeral",
      count: 42,
      enabled: true
    });

    const name = ephemeralObj.name;
    const count = ephemeralObj.count;
    const enabled = ephemeralObj.enabled;
    void name; void count; void enabled;
  });

  bench('Plexus: Materialized property access (untracked)', () => {
    // Force materialization first
    const { doc, projectId } = createYJSSetup();
    const materializedObj = new SimpleModelClass({
      name: "materialized",
      count: 42,
      enabled: true
    });
    // Materialize by referencing
    const ref = materializedObj[Symbol.for("reference")](projectId, doc);
    void ref;

    const name = materializedObj.name;
    const count = materializedObj.count;
    const enabled = materializedObj.enabled;
    void name; void count; void enabled;
  });
});

describe('Array Operations Performance', () => {
  bench('Plexus: Array push operations', () => {
    const obj = new LargeModelClass({
      items: [],
      lookup: {},
      counters: {}
    });

    // Perform multiple pushes (reduced from 100 to avoid heap exhaustion)
    for (let i = 0; i < 50; i++) {
      obj.items.push(new SimpleModelClass({
        name: `item-${i}`,
        count: i,
        enabled: i % 2 === 0
      }));
    }
  });

  bench('MobX: Array push operations', () => {
    const items = observable.array();

    for (let i = 0; i < 50; i++) {
      items.push(observable({
        name: `item-${i}`,
        count: i,
        enabled: i % 2 === 0
      }));
    }
  });

  bench('Plexus: Array access patterns', () => {
    const obj = new LargeModelClass({
      items: Array.from({ length: 100 }, (_, i) =>
        new SimpleModelClass({
          name: `item-${i}`,
          count: i,
          enabled: true
        })
      ),
      lookup: {},
      counters: {}
    });

    // Access every 10th item
    let sum = 0;
    for (let i = 0; i < 100; i += 10) {
      sum += obj.items[i]?.count ?? 0;
    }
    void sum;
  });

  bench('MobX: Array access patterns', () => {
    const items = observable.array(
      Array.from({ length: 100 }, (_, i) =>
        observable({
          name: `item-${i}`,
          count: i,
          enabled: true
        })
      )
    );

    let sum = 0;
    for (let i = 0; i < 100; i += 10) {
      sum += items[i]?.count ?? 0;
    }
    void sum;
  });
});

describe('Map Operations Performance', () => {
  bench('Plexus: Map set operations', () => {
    const obj = new LargeModelClass({
      items: [],
      lookup: {},
      counters: {}
    });

    for (let i = 0; i < 100; i++) {
      obj.lookup[`key-${i}`] = new SimpleModelClass({
        name: `value-${i}`,
        count: i,
        enabled: true
      });
      obj.counters[`counter-${i}`] = null;
    }
  });

  bench('MobX: Map set operations', () => {
    const lookup = observable.map();
    const counters = observable.map();

    for (let i = 0; i < 100; i++) {
      lookup.set(`key-${i}`, observable({
        name: `value-${i}`,
        count: i,
        enabled: true
      }));
      counters.set(`counter-${i}`, null);
    }
  });
});

describe('Reactivity Performance', () => {
  bench('Plexus: Tracking function creation', () => {
    const obj = new SimpleModelClass({
      name: "test",
      count: 0,
      enabled: true
    });

    let notificationCount = 0;
    const trackedFn = createTrackedFunction(() => {
      notificationCount++;
    }, () => {
      return obj.name + obj.count;
    });

    // Execute the tracked function
    trackedFn();
  });

  bench('MobX: Autorun creation', () => {
    const obj = createMobXSimple();

    let notificationCount = 0;
    const dispose = autorun(() => {
      notificationCount++;
      return obj.name + obj.count;
    });

    dispose();
  });

  bench('Plexus: Change notification speed', () => {
    const obj = new SimpleModelClass({
      name: "test",
      count: 0,
      enabled: true
    });

    let notificationCount = 0;
    const trackedFn = createTrackedFunction(() => {
      notificationCount++;
    }, () => obj.count);

    // Initial execution
    trackedFn();

    // Trigger changes
    for (let i = 0; i < 50; i++) {
      obj.count = i;
    }
  });

  bench('MobX: Change notification speed', () => {
    const obj = createMobXSimple();

    let notificationCount = 0;
    const dispose = autorun(() => {
      notificationCount++;
      return obj.count;
    });

    // Trigger changes
    for (let i = 0; i < 50; i++) {
      obj.count = i;
    }

    dispose();
  });

  bench('Plexus: Multiple observers', () => {
    const obj = new SimpleModelClass({
      name: "shared",
      count: 0,
      enabled: true
    });

    const disposers: Array<() => void> = [];

    // Create 20 observers
    for (let i = 0; i < 20; i++) {
      let localCount = 0;
      const trackedFn = createTrackedFunction(() => {
        localCount++;
      }, () => obj.count * i);

      trackedFn();
    }

    // Trigger change that affects all observers
    obj.count = 42;
  });

  bench('MobX: Multiple observers', () => {
    const obj = createMobXSimple();
    const disposers: Array<() => void> = [];

    // Create 20 observers
    for (let i = 0; i < 20; i++) {
      let localCount = 0;
      const dispose = autorun(() => {
        localCount++;
        return obj.count * i;
      });
      disposers.push(dispose);
    }

    // Trigger change that affects all observers
    obj.count = 42;

    // Cleanup
    disposers.forEach(dispose => dispose());
  });
});

describe('Batch Update Performance', () => {
  bench('Plexus: Batch property updates', () => {
    const obj = new SimpleModelClass({
      name: "test",
      count: 0,
      enabled: true
    });

    let notificationCount = 0;
    const trackedFn = createTrackedFunction(() => {
      notificationCount++;
    }, () => `${obj.name}-${obj.count}-${obj.enabled}`);

    trackedFn();

    // Batch updates (should ideally trigger fewer notifications)
    obj.name = "updated";
    obj.count = 100;
    obj.enabled = false;
  });

  bench('MobX: Batch property updates (runInAction)', () => {
    const obj = createMobXSimple();

    let notificationCount = 0;
    const dispose = autorun(() => {
      notificationCount++;
      return `${obj.name}-${obj.count}-${obj.enabled}`;
    });

    runInAction(() => {
      obj.name = "updated";
      obj.count = 100;
      obj.enabled = false;
    });

    dispose();
  });

  bench('MobX: Batch property updates (no action)', () => {
    const obj = createMobXSimple();

    let notificationCount = 0;
    const dispose = autorun(() => {
      notificationCount++;
      return `${obj.name}-${obj.count}-${obj.enabled}`;
    });

    // Updates without runInAction (should trigger multiple notifications)
    obj.name = "updated";
    obj.count = 100;
    obj.enabled = false;

    dispose();
  });
});

describe('Deep Hierarchy Performance', () => {
  function createDeepPlexusHierarchy(depth: number): any {
    if (depth <= 0) {
      return new SimpleModelClass({
        name: `leaf`,
        count: depth,
        enabled: true
      });
    }

    return new ComplexModelClass({
      id: `level-${depth}`,
      metadata: { level: depth.toString() },
      tags: [`tag-${depth}`],
      nested: createDeepPlexusHierarchy(depth - 1)
    });
  }

  function createDeepMobXHierarchy(depth: number): any {
    if (depth <= 0) {
      return observable({
        name: `leaf`,
        count: depth,
        enabled: true
      });
    }

    return observable({
      id: `level-${depth}`,
      metadata: observable.map([["level", depth.toString()]]),
      tags: observable.array([`tag-${depth}`]),
      nested: createDeepMobXHierarchy(depth - 1)
    });
  }

  bench('Plexus: Deep hierarchy creation (depth 10)', () => {
    const hierarchy = createDeepPlexusHierarchy(10);
    void hierarchy.id;
  });

  bench('MobX: Deep hierarchy creation (depth 10)', () => {
    const hierarchy = createDeepMobXHierarchy(10);
    void hierarchy.id;
  });

  bench('Plexus: Deep hierarchy access', () => {
    const hierarchy = createDeepPlexusHierarchy(10);

    // Navigate to leaf and access properties
    let current = hierarchy;
    while (current.nested) {
      current = current.nested;
    }

    const name = current.name;
    const count = current.count;
    void name; void count;
  });

  bench('MobX: Deep hierarchy access', () => {
    const hierarchy = createDeepMobXHierarchy(10);

    // Navigate to leaf and access properties
    let current = hierarchy;
    while (current.nested) {
      current = current.nested;
    }

    const name = current.name;
    const count = current.count;
    void name; void count;
  });
});

describe('Memory and Garbage Collection Patterns', () => {
  bench('Plexus: Object lifecycle stress test', () => {
    const objects: SimpleModel[] = [];

    // Create many objects
    for (let i = 0; i < 1000; i++) {
      objects.push(new SimpleModelClass({
        name: `obj-${i}`,
        count: i,
        enabled: i % 2 === 0
      }));
    }

    // Access random properties to ensure objects are "touched"
    for (let i = 0; i < 100; i++) {
      const obj = objects[Math.floor(Math.random() * objects.length)];
      void obj.name;
      void obj.count;
    }

    // Clear references (simulate cleanup)
    objects.length = 0;
  });

  bench('MobX: Object lifecycle stress test', () => {
    const objects: any[] = [];

    // Create many objects
    for (let i = 0; i < 1000; i++) {
      objects.push(observable({
        name: `obj-${i}`,
        count: i,
        enabled: i % 2 === 0
      }));
    }

    // Access random properties
    for (let i = 0; i < 100; i++) {
      const obj = objects[Math.floor(Math.random() * objects.length)];
      void obj.name;
      void obj.count;
    }

    // Clear references
    objects.length = 0;
  });
});

describe('YJS Collaboration Performance', () => {
  bench('Plexus: Ephemeral to Materialized conversion', () => {
    const { doc, projectId } = createYJSSetup();

    const obj = new SimpleModelClass({
      name: "test",
      count: 42,
      enabled: true
    });

    // Convert to materialized by creating reference
    const ref = obj[Symbol.for("reference")](projectId, doc);
    void ref;

    // Access materialized properties
    void obj.name;
    void obj.count;
  });

  bench('Plexus: Cross-document synchronization setup', () => {
    const doc1 = new Y.Doc() as any;
    doc1.rootProjectId = "project1";

    const doc2 = new Y.Doc() as any;
    doc2.rootProjectId = "project1";

    // Create objects in first document
    const obj1 = new SimpleModelClass({
      name: "shared",
      count: 100,
      enabled: true
    });
    const ref1 = obj1[Symbol.for("reference")]("project1", doc1);

    // Simulate document sync by applying updates
    const update = Y.encodeStateAsUpdate(doc1);
    Y.applyUpdate(doc2, update);
  });

  bench('Plexus: Large collaborative dataset', () => {
    const { doc, projectId } = createYJSSetup();

    const largeDataset = new LargeModelClass({
      items: [],
      lookup: {},
      counters: {}
    });

    // Add many items to collaborative structure
    for (let i = 0; i < 50; i++) {
      largeDataset.items.push(new SimpleModelClass({
        name: `collaborative-item-${i}`,
        count: i,
        enabled: true
      }));
    }

    // Materialize the dataset
    const ref = largeDataset[Symbol.for("reference")](projectId, doc);
    void ref;

    // Access some items to ensure they're properly materialized
    void largeDataset.items[0]?.name;
    void largeDataset.items[25]?.count;
  });
});

describe('Complex Real-World Scenarios', () => {
  bench('Plexus: Simulation of React component tree', () => {
    // Simulate a React component tree with state management
    const appState = new ComplexModelClass({
      id: "app",
      metadata: {
        theme: "dark",
        language: "en",
        version: "1.0.0"
      },
      tags: ["production", "stable"],
      nested: new SimpleModelClass({
        name: "user-prefs",
        count: 0,
        enabled: true
      })
    });

    // Simulate multiple components accessing different parts of state
    let renderCount = 0;

    // Component 1: Accesses theme
    const component1 = createTrackedFunction(() => renderCount++, () => {
      return appState.metadata["theme"];
    });

    // Component 2: Accesses user preferences
    const component2 = createTrackedFunction(() => renderCount++, () => {
      return appState.nested?.name + appState.nested?.count;
    });

    // Component 3: Accesses tags
    const component3 = createTrackedFunction(() => renderCount++, () => {
      return appState.tags.join(",");
    });

    // Initial renders
    component1();
    component2();
    component3();

    // Simulate state changes
    appState.metadata["theme"] = "light";
    appState.nested!.count = 5;
    appState.tags.push("updated");
  });

  bench('MobX: Simulation of React component tree', () => {
    const appState = observable({
      id: "app",
      metadata: observable.map([
        ["theme", "dark"],
        ["language", "en"],
        ["version", "1.0.0"]
      ]),
      tags: observable.array(["production", "stable"]),
      nested: observable({
        name: "user-prefs",
        count: 0,
        enabled: true
      })
    });

    let renderCount = 0;

    // Component reactions
    const dispose1 = autorun(() => {
      renderCount++;
      return appState.metadata.get("theme");
    });

    const dispose2 = autorun(() => {
      renderCount++;
      return appState.nested?.name + appState.nested?.count;
    });

    const dispose3 = autorun(() => {
      renderCount++;
      return appState.tags.join(",");
    });

    // Simulate state changes
    runInAction(() => {
      appState.metadata.set("theme", "light");
      appState.nested!.count = 5;
      appState.tags.push("updated");
    });

    // Cleanup
    dispose1();
    dispose2();
    dispose3();
  });
});
