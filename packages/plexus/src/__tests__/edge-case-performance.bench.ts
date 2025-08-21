/**
 * Edge Case Performance Tests for Plexus vs MobX
 * 
 * Tests focusing on pathological cases and edge conditions that might
 * reveal performance characteristics not visible in normal usage patterns.
 */

import { bench, describe } from 'vitest';
import { observable, autorun, configure } from 'mobx';
import * as Y from 'yjs';
import { buildModelClass, type ProjectId } from '../proxy-runtime.js';
import { createTrackedFunction } from '../tracking.js';
import type { ModelType } from '../proxy-runtime-types.js';

// Configure MobX for performance
configure({
  enforceActions: "never",
  computedRequiresReaction: false,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
  disableErrorBoundaries: true
});

// Sparse array model
type SparseArrayModel = ModelType<{
  sparseItems: "list";
  indices: "map";
}, "SparseArrayModel">;

// Deep chain model  
type ChainNode = ModelType<{
  id: string;
  next: ChainNode | null;
  metadata: "map";
}, "ChainNode">;

const SparseArrayModelClass = buildModelClass<SparseArrayModel>("SparseArrayModel", {
  sparseItems: "list",
  indices: "map"
});

const ChainNodeClass = buildModelClass<ChainNode>("ChainNode", {
  id: "val",
  next: "val", 
  metadata: "map"
});

function createYJSSetup() {
  const doc = new Y.Doc() as any;
  doc.rootProjectId = "test-project";
  return { doc, projectId: "test-project" as ProjectId };
}

describe('Sparse Array Performance', () => {
  bench('Plexus: Sparse array with holes', () => {
    const model = SparseArrayModelClass({
      sparseItems: [],
      indices: {}
    });

    // Create sparse array with holes (every 10th index)
    for (let i = 0; i < 1000; i += 10) {
      model.sparseItems[i] = ChainNodeClass({
        id: `node-${i}`,
        next: null,
        metadata: {}
      });
    }

    // Access various indices including holes
    let sum = 0;
    for (let i = 0; i < 1000; i += 5) {
      const item = model.sparseItems[i];
      if (item) {
        sum += parseInt(item.id.split('-')[1]);
      }
    }
    void sum;
  });

  bench('MobX: Sparse array with holes', () => {
    const items = observable.array();

    // Create sparse array with holes
    for (let i = 0; i < 1000; i += 10) {
      items[i] = observable({
        id: `node-${i}`,
        next: null,
        metadata: observable.map()
      });
    }

    // Access various indices including holes
    let sum = 0;
    for (let i = 0; i < 1000; i += 5) {
      const item = items[i];
      if (item) {
        sum += parseInt(item.id.split('-')[1]);
      }
    }
    void sum;
  });

  bench('Plexus: Array length manipulation', () => {
    const model = SparseArrayModelClass({
      sparseItems: Array.from({ length: 100 }, (_, i) => 
        ChainNodeClass({ id: `item-${i}`, next: null, metadata: {} })
      ),
      indices: {}
    });

    // Repeatedly truncate and extend array
    for (let i = 0; i < 10; i++) {
      model.sparseItems.length = 50; // Truncate
      model.sparseItems.length = 100; // Extend (creates holes)
      
      // Fill some of the holes
      for (let j = 50; j < 75; j++) {
        model.sparseItems[j] = ChainNodeClass({
          id: `new-${j}`,
          next: null,
          metadata: {}
        });
      }
    }
  });

  bench('MobX: Array length manipulation', () => {
    const items = observable.array(
      Array.from({ length: 100 }, (_, i) => 
        observable({ id: `item-${i}`, next: null, metadata: observable.map() })
      )
    );

    // Repeatedly truncate and extend
    for (let i = 0; i < 10; i++) {
      items.length = 50; // Truncate
      items.length = 100; // Extend
      
      // Fill holes
      for (let j = 50; j < 75; j++) {
        items[j] = observable({
          id: `new-${j}`,
          next: null,
          metadata: observable.map()
        });
      }
    }
  });
});

describe('Deep Proxy Chain Performance', () => {
  function createPlexusChain(length: number): ChainNode {
    let head: ChainNode | null = null;
    
    // Build chain backwards
    for (let i = length - 1; i >= 0; i--) {
      const node = ChainNodeClass({
        id: `node-${i}`,
        next: head,
        metadata: { index: i.toString() }
      });
      head = node;
    }
    
    return head!;
  }

  function createMobXChain(length: number): any {
    let head: any = null;
    
    for (let i = length - 1; i >= 0; i--) {
      const node = observable({
        id: `node-${i}`,
        next: head,
        metadata: observable.map([["index", i.toString()]])
      });
      head = node;
    }
    
    return head;
  }

  bench('Plexus: Deep chain traversal (100 nodes)', () => {
    const head = createPlexusChain(100);
    
    // Traverse entire chain
    let current = head;
    let count = 0;
    while (current) {
      count++;
      void current.id;
      current = current.next;
    }
    void count;
  });

  bench('MobX: Deep chain traversal (100 nodes)', () => {
    const head = createMobXChain(100);
    
    // Traverse entire chain
    let current = head;
    let count = 0;
    while (current) {
      count++;
      void current.id;
      current = current.next;
    }
    void count;
  });

  bench('Plexus: Chain modification at depth', () => {
    const head = createPlexusChain(50);
    
    // Navigate to middle and modify
    let current = head;
    for (let i = 0; i < 25; i++) {
      current = current.next!;
    }
    
    // Modify metadata deep in chain
    current.metadata["modified"] = "true";
    current.metadata["timestamp"] = Date.now().toString();
  });

  bench('MobX: Chain modification at depth', () => {
    const head = createMobXChain(50);
    
    // Navigate to middle and modify
    let current = head;
    for (let i = 0; i < 25; i++) {
      current = current.next;
    }
    
    // Modify metadata deep in chain
    current.metadata.set("modified", "true");
    current.metadata.set("timestamp", Date.now().toString());
  });
});

describe('Circular Reference Performance', () => {
  bench('Plexus: Circular reference creation and access', () => {
    const node1 = ChainNodeClass({
      id: "node1",
      next: null,
      metadata: {}
    });
    
    const node2 = ChainNodeClass({
      id: "node2", 
      next: node1,
      metadata: {}
    });
    
    // Create circular reference
    node1.next = node2;
    
    // Access properties through circular chain
    let current = node1;
    for (let i = 0; i < 10; i++) {
      void current.id;
      current = current.next!;
    }
  });

  bench('MobX: Circular reference creation and access', () => {
    const node1 = observable({
      id: "node1",
      next: null as any,
      metadata: observable.map()
    });
    
    const node2 = observable({
      id: "node2",
      next: node1,
      metadata: observable.map()
    });
    
    // Create circular reference
    node1.next = node2;
    
    // Access properties through circular chain
    let current = node1;
    for (let i = 0; i < 10; i++) {
      void current.id;
      current = current.next;
    }
  });
});

describe('Property Enumeration Performance', () => {
  bench('Plexus: Object.keys() on complex objects', () => {
    const node = ChainNodeClass({
      id: "test",
      next: null,
      metadata: {}
    });
    
    // Add many metadata properties
    for (let i = 0; i < 100; i++) {
      node.metadata[`key-${i}`] = ChainNodeClass({
        id: `value-${i}`,
        next: null,
        metadata: {}
      });
    }
    
    // Enumerate keys multiple times
    for (let i = 0; i < 10; i++) {
      const keys = Object.keys(node.metadata);
      void keys.length;
    }
  });

  bench('MobX: keys() on complex objects', () => {
    const metadata = observable.map();
    
    // Add many properties
    for (let i = 0; i < 100; i++) {
      metadata.set(`key-${i}`, observable({
        id: `value-${i}`,
        next: null,
        metadata: observable.map()
      }));
    }
    
    // Enumerate keys multiple times
    for (let i = 0; i < 10; i++) {
      const keys = Array.from(metadata.keys());
      void keys.length;
    }
  });
});

describe('Concurrent Access Patterns', () => {
  bench('Plexus: Simultaneous readers on shared object', () => {
    const sharedObject = SparseArrayModelClass({
      sparseItems: Array.from({ length: 50 }, (_, i) => 
        ChainNodeClass({ id: `shared-${i}`, next: null, metadata: {} })
      ),
      indices: {}
    });

    // Simulate multiple "threads" reading concurrently
    const readers = Array.from({ length: 10 }, (_, readerId) => {
      return createTrackedFunction(() => {
        // Reader notification callback
      }, () => {
        let sum = 0;
        // Each reader accesses different slice
        const start = readerId * 5;
        const end = start + 5;
        
        for (let i = start; i < end && i < sharedObject.sparseItems.length; i++) {
          const item = sharedObject.sparseItems[i];
          if (item) {
            sum += i;
          }
        }
        return sum;
      });
    });

    // Execute all readers
    readers.forEach(reader => reader());
  });

  bench('MobX: Simultaneous readers on shared object', () => {
    const sharedItems = observable.array(
      Array.from({ length: 50 }, (_, i) => 
        observable({ id: `shared-${i}`, next: null, metadata: observable.map() })
      )
    );

    // Simulate multiple reactions reading concurrently
    const disposers = Array.from({ length: 10 }, (_, readerId) => {
      return autorun(() => {
        let sum = 0;
        const start = readerId * 5;
        const end = start + 5;
        
        for (let i = start; i < end && i < sharedItems.length; i++) {
          const item = sharedItems[i];
          if (item) {
            sum += i;
          }
        }
        return sum;
      });
    });

    // Cleanup
    disposers.forEach(dispose => dispose());
  });

  bench('Plexus: Writer with multiple readers conflict', () => {
    const contestedObject = ChainNodeClass({
      id: "contested",
      next: null,
      metadata: {}
    });

    // Set up readers
    const readers = Array.from({ length: 5 }, () => {
      return createTrackedFunction(() => {
        // Reader was notified
      }, () => {
        const keys = Object.keys(contestedObject.metadata);
        return keys.reduce((acc, key) => acc + key.length, 0);
      });
    });

    // Initial read to establish tracking
    readers.forEach(reader => reader());

    // Writer rapidly modifies while readers are watching
    for (let i = 0; i < 20; i++) {
      contestedObject.metadata[`rapid-${i}`] = null;
      
      // Some readers might read during modification
      if (i % 3 === 0) {
        readers[i % readers.length]();
      }
    }
  });

  bench('MobX: Writer with multiple readers conflict', () => {
    const contestedObject = observable({
      id: "contested",
      next: null,
      metadata: observable.map()
    });

    // Set up readers
    const disposers = Array.from({ length: 5 }, () => {
      return autorun(() => {
        const keys = Array.from(contestedObject.metadata.keys());
        return keys.reduce((acc, key) => acc + key.length, 0);
      });
    });

    // Writer rapidly modifies
    for (let i = 0; i < 20; i++) {
      contestedObject.metadata.set(`rapid-${i}`, null);
    }

    // Cleanup
    disposers.forEach(dispose => dispose());
  });
});

describe('Memory Stress Patterns', () => {
  bench('Plexus: Rapid object creation/destruction', () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      // Create batch of objects
      const batch = Array.from({ length: 100 }, (_, i) => 
        ChainNodeClass({
          id: `temp-${cycle}-${i}`,
          next: null,
          metadata: { cycle: cycle.toString() }
        })
      );
      
      // Use objects briefly
      batch.forEach((obj, i) => {
        if (i % 10 === 0) {
          void obj.id;
          void obj.metadata["cycle"];
        }
      });
      
      // Objects go out of scope (eligible for GC)
    }
  });

  bench('MobX: Rapid object creation/destruction', () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      // Create batch of objects
      const batch = Array.from({ length: 100 }, (_, i) => 
        observable({
          id: `temp-${cycle}-${i}`,
          next: null,
          metadata: observable.map([["cycle", cycle.toString()]])
        })
      );
      
      // Use objects briefly
      batch.forEach((obj, i) => {
        if (i % 10 === 0) {
          void obj.id;
          void obj.metadata.get("cycle");
        }
      });
      
      // Objects go out of scope
    }
  });
});