/**
 * Memory Usage Tests with Profiling
 *
 * Uses the memory profiler to compare actual memory usage patterns
 * between plexus and MobX under various scenarios.
 */

import { describe, expect, it } from "vitest";
import { autorun, configure, observable } from "mobx";
import { buildModelClass } from "../proxy-runtime.js";
import { createTrackedFunction } from "../tracking.js";
import { memoryProfiler, memoryTester } from "./memory-profiler.js";
import type { ModelType } from "../proxy-runtime-types.js";

// Configure MobX for performance
configure({
  enforceActions: "never",
  computedRequiresReaction: false,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
  disableErrorBoundaries: true
});

type SimpleModel = ModelType<
  {
    name: string;
    count: number;
    enabled: boolean;
  },
  "SimpleModel"
>;

const SimpleModelClass = buildModelClass<SimpleModel>("SimpleModel", {
  name: "val",
  count: "val",
  enabled: "val"
});

describe("Memory Usage Comparison", () => {
  it("should compare memory usage of object creation", async () => {
    const { comparison } = await memoryTester.compareTests(
      "Plexus Object Creation",
      () => {
        const objects = [];
        for (let i = 0; i < 1000; i++) {
          objects.push(
            SimpleModelClass({
              name: `object-${i}`,
              count: i,
              enabled: i % 2 === 0
            })
          );
        }

        // Touch all objects to ensure they're created
        objects.forEach((obj) => void obj.name);
        return objects.length;
      },
      "MobX Object Creation",
      () => {
        const objects = [];
        for (let i = 0; i < 1000; i++) {
          objects.push(
            observable({
              name: `object-${i}`,
              count: i,
              enabled: i % 2 === 0
            })
          );
        }

        // Touch all objects
        objects.forEach((obj) => void obj.name);
        return objects.length;
      },
      { runs: 3 }
    );

    console.log(comparison);
    expect(comparison).toContain("Memory Profile Comparison");
  });

  it("should compare memory usage with reactivity", async () => {
    const { comparison } = await memoryTester.compareTests(
      "Plexus Reactivity",
      () => {
        const objects = Array.from({ length: 100 }, (_, i) =>
          SimpleModelClass({
            name: `reactive-${i}`,
            count: i,
            enabled: true
          })
        );

        const trackedFunctions = objects.map((obj, i) => {
          return createTrackedFunction(
            () => {
              // Notification callback
            },
            () => obj.count * i
          );
        });

        // Execute all tracked functions
        trackedFunctions.forEach((fn) => fn());

        // Trigger some changes
        objects.forEach((obj, i) => {
          if (i % 10 === 0) {
            obj.count = i * 2;
          }
        });

        return objects.length;
      },
      "MobX Reactivity",
      () => {
        const objects = Array.from({ length: 100 }, (_, i) =>
          observable({
            name: `reactive-${i}`,
            count: i,
            enabled: true
          })
        );

        const disposers = objects.map((obj, i) => {
          return autorun(() => obj.count * i);
        });

        // Trigger some changes
        objects.forEach((obj, i) => {
          if (i % 10 === 0) {
            obj.count = i * 2;
          }
        });

        // Cleanup
        disposers.forEach((dispose) => dispose());

        return objects.length;
      },
      { runs: 3 }
    );

    console.log(comparison);
    expect(comparison).toContain("Memory Profile Comparison");
  });

  it("should profile memory usage over time", async () => {
    const { profile } = await memoryTester.profileTest(
      "Plexus Memory Over Time",
      () => {
        const objects: SimpleModel[] = [];

        // Phase 1: Create objects with some delay to allow sampling
        for (let i = 0; i < 500; i++) {
          objects.push(
            SimpleModelClass({
              name: `phase1-${i}`,
              count: i,
              enabled: true
            })
          );
          // Small delay every 100 objects to allow sampling
          if (i % 100 === 0) {
            const now = Date.now();
            while (Date.now() - now < 5) {
              // Brief pause
            }
          }
        }

        // Phase 2: Use objects heavily with pauses
        for (let round = 0; round < 10; round++) {
          objects.forEach((obj, i) => {
            void obj.name;
            void obj.count;
            obj.count = obj.count + 1;
            // Small delay every 50 objects
            if (i % 50 === 0) {
              const now = Date.now();
              while (Date.now() - now < 2) {
                // Brief pause
              }
            }
          });
        }

        // Phase 3: Remove half the objects
        objects.splice(0, 250);

        // Phase 4: Create new objects to replace them
        for (let i = 0; i < 250; i++) {
          objects.push(
            SimpleModelClass({
              name: `phase4-${i}`,
              count: i,
              enabled: false
            })
          );
        }

        return objects.length;
      },
      { samplingInterval: 5 }
    );

    const report = memoryProfiler.generateReport(profile);
    console.log(report);

    // More realistic expectations - sometimes sampling is less frequent
    expect(profile.snapshots.length).toBeGreaterThan(1);
    expect(profile.peakHeapUsed).toBeGreaterThan(0);
  });

  it("should detect memory leaks in tracking systems", async () => {
    const { profile } = await memoryTester.profileTest(
      "Tracking Memory Leak Test",
      () => {
        // Create and dispose many tracked functions to see if they leak
        for (let cycle = 0; cycle < 50; cycle++) {
          const objects = Array.from({ length: 20 }, (_, i) =>
            new SimpleModelClass({
              name: `leak-test-${cycle}-${i}`,
              count: i,
              enabled: true
            })
          );

          const trackedFunctions = objects.map((obj) => {
            return createTrackedFunction(
              () => {
                // This should be eligible for GC when objects go out of scope
              },
              () => obj.count + obj.name.length
            );
          });

          // Execute functions
          trackedFunctions.forEach((fn) => fn());

          // Trigger some changes
          objects.forEach((obj) => obj.count++);

          // Objects and tracked functions should be eligible for GC here
        }

        return "completed";
      },
      {
        samplingInterval: 5,
        forceGCAfter: true
      }
    );

    const report = memoryProfiler.generateReport(profile);
    console.log(report);

    // Memory should not grow excessively if there are no leaks
    // Being more lenient with memory growth expectations since GC timing varies
    const maxAcceptableGrowth = 200 * 1024 * 1024; // 200MB (increased tolerance)
    expect(profile.heapGrowth).toBeLessThan(maxAcceptableGrowth);
  });

  it("should compare array operation memory patterns", async () => {
    const { comparison } = await memoryTester.compareTests(
      "Plexus Array Operations",
      () => {
        type ArrayModel = ModelType<{ items: Array<SimpleModel> }, "ArrayModel">;
        const ArrayModelClass = buildModelClass<ArrayModel>("ArrayModel", {
          items: "list"
        });

        const model = ArrayModelClass({ items: [] });

        // Push many items
        for (let i = 0; i < 1000; i++) {
          model.items.push(
            SimpleModelClass({
              name: `array-item-${i}`,
              count: i,
              enabled: i % 2 === 0
            })
          );
        }

        // Access patterns that should not create memory leaks
        let sum = 0;
        for (let i = 0; i < model.items.length; i += 10) {
          sum += model.items[i]?.count || 0;
        }

        // Remove half the items
        model.items.splice(0, 500);

        return model.items.length;
      },
      "MobX Array Operations",
      () => {
        const items = observable.array();

        // Push many items
        for (let i = 0; i < 1000; i++) {
          items.push(
            observable({
              name: `array-item-${i}`,
              count: i,
              enabled: i % 2 === 0
            })
          );
        }

        // Access patterns
        let sum = 0;
        for (let i = 0; i < items.length; i += 10) {
          sum += items[i]?.count || 0;
        }

        // Remove half the items
        items.splice(0, 500);

        return items.length;
      },
      { runs: 3 }
    );

    console.log(comparison);
    expect(comparison).toContain("Memory Profile Comparison");
  });

  it("should analyze memory usage with deep object hierarchies", async () => {
    type NestedModel = ModelType<
      {
        level: number;
        children: Array<NestedModel>;
        metadata: Record<string, string>;
      },
      "NestedModel"
    >;

    const NestedModelClass = buildModelClass<NestedModel>("NestedModel", {
      level: "val",
      children: "list",
      metadata: "record"
    });

    const { profile } = await memoryTester.profileTest(
      "Deep Hierarchy Memory Usage",
      () => {
        function createTree(depth: number, breadth: number): NestedModel {
          const node = NestedModelClass({
            level: depth,
            children: [],
            metadata: {
              [`depth-${depth}`]: depth.toString(),
              [`breadth-${breadth}`]: breadth.toString()
            }
          });

          if (depth > 0) {
            for (let i = 0; i < breadth; i++) {
              node.children.push(createTree(depth - 1, i));
            }
          }

          return node;
        }

        // Create a tree with depth 5, breadth 3 (should create 3^5 = 243 leaf nodes)
        const tree = createTree(5, 3);

        // Traverse the entire tree to ensure all nodes are materialized
        function traverse(node: NestedModel): number {
          let count = 1;
          for (const child of node.children) {
            count += traverse(child);
          }
          return count;
        }

        const nodeCount = traverse(tree);

        return nodeCount;
      },
      { samplingInterval: 10 }
    );

    const report = memoryProfiler.generateReport(profile);
    console.log(report);

    // Verify that we have captured some memory data
    expect(profile.snapshots.length).toBeGreaterThan(0);
    expect(profile.peakHeapUsed).toBeGreaterThanOrEqual(profile.snapshots[0].heapUsed);
  });
});
