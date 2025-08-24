/**
 * Focused Property Access Benchmarks: Ephemeral vs Materialized vs MobX
 *
 * Lightweight test focused specifically on property access patterns
 * to avoid memory exhaustion while testing the core hypothesis.
 */

import { bench, describe } from 'vitest';
import { observable, autorun, configure } from 'mobx';
import * as Y from 'yjs';
import { buildModelClass, type ProjectId } from '../proxy-runtime.js';
import { createTrackedFunction } from '../tracking.js';
import type { ModelType } from '../proxy-runtime-types.js';
import { YJS_GLOBALS } from "../YJS_GLOBALS";

// Configure MobX for optimal performance
configure({
  enforceActions: "never",
  computedRequiresReaction: false,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
  disableErrorBoundaries: true
});

// Simple model for testing
type SimpleModel = ModelType<{
  name: string;
  count: number;
  enabled: boolean;
}, "SimpleModel">;

const SimpleModelClass = buildModelClass<SimpleModel>("SimpleModel", {
  name: "val",
  count: "val",
  enabled: "val"
});

// Helper to create YJS document setup
function createYJSSetup() {
  const doc = new Y.Doc() as any;
  doc.getMap(YJS_GLOBALS.metadataMap).set(YJS_GLOBALS.metadataMapFields.projectId, "test-project");
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

describe('Property Access Performance Comparison', () => {

  bench('Plexus: Ephemeral property access (untracked)', () => {
    // Pure ephemeral - no YJS involvement, no tracking
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

  bench('MobX: Property access (untracked)', () => {
    const mobxObj = createMobXSimple();

    const name = mobxObj.name;
    const count = mobxObj.count;
    const enabled = mobxObj.enabled;
    void name; void count; void enabled;
  });

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

  bench('Plexus: Materialized property access (tracked)', () => {
    // Force materialization first
    const { doc, projectId } = createYJSSetup();
    const materializedObj = new SimpleModelClass({
      name: "materialized-tracked",
      count: 42,
      enabled: true
    });
    // Materialize by referencing
    const ref = materializedObj[Symbol.for("reference")](projectId, doc);
    void ref;

    const trackedFn = createTrackedFunction(() => {
      // Tracking callback
    }, () => {
      const name = materializedObj.name;
      const count = materializedObj.count;
      const enabled = materializedObj.enabled;
      void name; void count; void enabled;
      return name + count;
    });

    trackedFn();
  });
});
