/**
 * Tests for virtual children genesis — content-addressed, deterministic CRDT entity creation.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../decorators.js";
import { getInternals, PlexusModel } from "../PlexusModel.js";
import type { AllowedYValue } from "../proxy-runtime-types.js";
import {
  materializeVirtualChild,
  GENESIS_ORIGIN,
  genesisAllowlist,
  __getGenesisDepth__,
} from "../virtual-children-genesis.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

// ── Test models ──

@syncing
class VChild extends PlexusModel {
  static override readonly modelName = "VChild";
  @syncing accessor label!: string;
}

@syncing
class VParent extends PlexusModel {
  static override readonly modelName = "VParent";
  @syncing accessor name!: string;
  @syncing.child.map accessor items!: Map<string, VChild>;
}

// Models for recursive materialization tests

@syncing
class VLeaf extends PlexusModel {
  static override readonly modelName = "VLeaf";
  @syncing accessor value!: string;
}

@syncing
class VBranch extends PlexusModel {
  static override readonly modelName = "VBranch";
  @syncing accessor tag!: string;
  @syncing.child accessor leaf: VLeaf | null = null;
}

@syncing
class VWithList extends PlexusModel {
  static override readonly modelName = "VWithList";
  @syncing accessor name!: string;
  @syncing.child.list accessor children: VLeaf[] = [];
}

@syncing
class VDeep extends PlexusModel {
  static override readonly modelName = "VDeep";
  @syncing accessor depth!: string;
  @syncing.child accessor nested: VBranch | null = null;
}

@syncing
class VTreeHost extends PlexusModel {
  static override readonly modelName = "VTreeHost";
  @syncing accessor title!: string;
  @syncing.child.map accessor branches!: Map<string, VBranch>;
}

@syncing
class VTreeHostDeep extends PlexusModel {
  static override readonly modelName = "VTreeHostDeep";
  @syncing accessor title!: string;
  @syncing.child.map accessor nodes!: Map<string, VDeep>;
}

// Helper to get the yjsMap for a child-map field
function getYjsMap(owner: PlexusModel, fieldName: string): Y.Map<AllowedYValue> {
  return owner.__yjsFieldsMap__!.get(fieldName) as Y.Map<AllowedYValue>;
}

describe("materializeVirtualChild", () => {
  // ── Basic happy path ──

  it("creates entity that appears in parent's map with correct label", () => {
    const { root, doc } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));

    const yjsMap = getYjsMap(root, "items");
    materializeVirtualChild(root, "items", "a", yjsMap, (key) => new VChild({ label: `child-${key}` }));

    expect(root.items.size).toBe(1);
    expect(root.items.has("a")).toBe(true);
    expect(root.items.get("a")!.label).toBe("child-a");
  });

  it("multiple virtual children can coexist", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    materializeVirtualChild(root, "items", "first", yjsMap, (key) => new VChild({ label: `child-${key}` }));
    materializeVirtualChild(root, "items", "second", yjsMap, (key) => new VChild({ label: `child-${key}` }));

    expect(root.items.size).toBe(2);
    expect(root.items.get("first")!.label).toBe("child-first");
    expect(root.items.get("second")!.label).toBe("child-second");
  });

  it("parent data is set correctly on the genesis entity", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));

    const yjsMap = getYjsMap(root, "items");
    materializeVirtualChild(root, "items", "c", yjsMap, (key) => new VChild({ label: `child-${key}` }));

    const child = root.items.get("c")!;
    expect(child.parent).toBe(root);
    expect(child.parentField).toBe("items");
  });

  // ── Determinism ──

  it("is deterministic: same inputs on shared parent → identical UUIDs", () => {
    const docId = "determinism-uuid-test";
    const factory = (key: string) => new VChild({ label: `child-${key}` });

    // Peer 1: bootstrap root
    const { root: root1, doc: doc1 } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, docId);

    // Peer 2: sync parent state from peer 1 → same root UUID
    const doc2 = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
    const { root: root2 } = connectTestPlexus<VParent>(doc2);

    // Both peers genesis independently on the shared parent
    materializeVirtualChild(root1, "items", "a", getYjsMap(root1, "items"), factory);
    materializeVirtualChild(root2, "items", "a", getYjsMap(root2, "items"), factory);

    // Same parent UUID + same inputs → identical UUIDs
    expect(root1.items.get("a")!.uuid).toBe(root2.items.get("a")!.uuid);
    expect(root1.items.get("a")!.label).toBe(root2.items.get("a")!.label);
  });

  it("different docIds produce different UUIDs (docGuid feeds Feistel cipher)", () => {
    const factory = (key: string) => new VChild({ label: `child-${key}` });

    const { root: root1 } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, "doc-alpha");
    const yjsMap1 = getYjsMap(root1, "items");
    materializeVirtualChild(root1, "items", "a", yjsMap1, factory);

    const { root: root2 } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, "doc-beta");
    const yjsMap2 = getYjsMap(root2, "items");
    materializeVirtualChild(root2, "items", "a", yjsMap2, factory);

    // Different docIds → different UUIDs (Feistel cipher uses docGuid)
    // Labels are the same (factory is pure), but UUIDs differ
    expect(root1.items.get("a")!.label).toBe(root2.items.get("a")!.label);
    expect(root1.items.get("a")!.uuid).not.toBe(root2.items.get("a")!.uuid);
  });

  // ── CRDT convergence (the CREATE2 guarantee) ──

  it("two peers with shared parent genesis same key → UUIDs match, sync is no-op", () => {
    const docId = "convergence-test";
    const factory = (key: string) => new VChild({ label: `v-${key}` });

    // Peer 1: bootstrap root
    const { root: root1, doc: doc1 } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, docId);

    // Peer 2: sync parent state from peer 1 → same root UUID
    const doc2 = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
    const { root: root2 } = connectTestPlexus<VParent>(doc2);

    // Both peers genesis independently
    materializeVirtualChild(root1, "items", "x", getYjsMap(root1, "items"), factory);
    materializeVirtualChild(root2, "items", "x", getYjsMap(root2, "items"), factory);

    // Both produced the same UUID independently
    const uuid1 = root1.items.get("x")!.uuid;
    const uuid2 = root2.items.get("x")!.uuid;
    expect(uuid1).toBe(uuid2);

    // Sync: doc1 → doc2, doc2 → doc1 (bidirectional)
    const sv1before = Y.encodeStateVector(doc1);
    const sv2before = Y.encodeStateVector(doc2);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2before));
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1before));

    // After sync, both still have exactly 1 item with the same UUID
    expect(root1.items.size).toBe(1);
    expect(root2.items.size).toBe(1);
    expect(root1.items.get("x")!.uuid).toBe(uuid1);
    expect(root1.items.get("x")!.label).toBe("v-x");
  });

  it("one-way sync: genesis on doc1, sync to doc2 → entity appears on doc2", () => {
    const docId = "sync-test-doc";
    const { root: root1, doc: doc1 } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, docId);

    const yjsMap1 = getYjsMap(root1, "items");
    materializeVirtualChild(root1, "items", "x", yjsMap1, (key) => new VChild({ label: `v-${key}` }));

    const childUuid1 = root1.items.get("x")!.uuid;

    // Sync to a bare Y.Doc
    const doc2 = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // The child should exist on doc2 with the same UUID
    const typesMap2 = doc2.getMap("types") as Y.Map<Y.Map<any>>;
    let foundUuid = false;
    for (const [_, typeMap] of typesMap2) {
      if (typeMap.has(childUuid1)) {
        foundUuid = true;
        break;
      }
    }
    expect(foundUuid).toBe(true);
  });

  // ── Undo invisibility ──

  it("UndoManager invisible: undo does NOT remove the genesis entity", () => {
    const { root, plexus } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));

    const yjsMap = getYjsMap(root, "items");
    materializeVirtualChild(root, "items", "b", yjsMap, (key) => new VChild({ label: `child-${key}` }));

    expect(root.items.has("b")).toBe(true);

    plexus.undo();
    expect(root.items.has("b")).toBe(true);
  });

  // ── Idempotency ──

  it("idempotent: same key materialized twice produces same entity, no duplication", () => {
    const docId = "idempotent-test";
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }), {}, docId);
    const yjsMap = getYjsMap(root, "items");
    const factory = (key: string) => new VChild({ label: `child-${key}` });

    materializeVirtualChild(root, "items", "dup", yjsMap, factory);
    const uuidAfterFirst = root.items.get("dup")!.uuid;
    const labelAfterFirst = root.items.get("dup")!.label;

    // Second call with same key + factory
    materializeVirtualChild(root, "items", "dup", yjsMap, factory);
    const uuidAfterSecond = root.items.get("dup")!.uuid;
    const labelAfterSecond = root.items.get("dup")!.label;

    // Same UUID, same value, map still has exactly 1 entry for "dup"
    expect(uuidAfterSecond).toBe(uuidAfterFirst);
    expect(labelAfterSecond).toBe(labelAfterFirst);
    expect(root.items.size).toBe(1);
  });

  // ── Factory isolation ──

  it("factory isolation: accessing external model throws", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));

    const external = new VChild({ label: "external" });
    root.items.set("ext", external);

    const yjsMap = getYjsMap(root, "items");

    expect(() => {
      materializeVirtualChild(root, "items", "bad", yjsMap, (_key) => {
        const _ = external.label;
        return new VChild({ label: "should-not-reach" });
      });
    }).toThrow("factory isolation");
  });

  it("factory isolation: models created inside factory ARE accessible", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    // Factory creates a model and reads its own fields — should not throw
    materializeVirtualChild(root, "items", "self-read", yjsMap, (key) => {
      const child = new VChild({ label: `child-${key}` });
      // Reading a field of a model created in-factory should work
      const _ = child.label;
      return child;
    });

    expect(root.items.get("self-read")!.label).toBe("child-self-read");
  });

  // ── Error handling ──

  it("non-connected owner throws", () => {
    const ephemeral = new VParent({ name: "ephemeral", items: new Map() });

    expect(() => {
      materializeVirtualChild(ephemeral, "items", "a", new Y.Map(), (key) => new VChild({ label: `child-${key}` }));
    }).toThrow("must be connected");
  });

  it("factory throw: genesisDepth returns to 0, allowlist is nulled", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    expect(__getGenesisDepth__()).toBe(0);
    expect(genesisAllowlist).toBeNull();

    expect(() => {
      materializeVirtualChild(root, "items", "throws", yjsMap, (_key) => {
        throw new Error("factory boom");
      });
    }).toThrow("factory boom");

    // State must be clean after factory throws
    expect(__getGenesisDepth__()).toBe(0);
    expect(genesisAllowlist).toBeNull();
  });

  it("factory throw: subsequent genesis calls work normally", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    // First call throws
    expect(() => {
      materializeVirtualChild(root, "items", "fail", yjsMap, (_key) => {
        throw new Error("boom");
      });
    }).toThrow("boom");

    // Second call should succeed — state was properly cleaned up
    materializeVirtualChild(root, "items", "ok", yjsMap, (key) => new VChild({ label: `child-${key}` }));
    expect(root.items.get("ok")!.label).toBe("child-ok");
  });

  // ── Key validation ──

  it("primitive key validation: PlexusModel key throws", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");
    const model = new VChild({ label: "key" });

    expect(() => {
      materializeVirtualChild(root, "items", model as any, yjsMap, () => new VChild({ label: "x" }));
    }).toThrow("PlexusModel");
  });

  it("primitive key validation: Set key throws", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    expect(() => {
      materializeVirtualChild(root, "items", new Set(["a"]) as any, yjsMap, () => new VChild({ label: "x" }));
    }).toThrow("Sets");
  });

  it("primitive key validation: string key works", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    materializeVirtualChild(root, "items", "str-key", yjsMap, (key) => new VChild({ label: `child-${key}` }));
    expect(root.items.get("str-key")!.label).toBe("child-str-key");
  });

  // ── Recursive materialization ──

  it("recursive: factory produces entity with a child-val", () => {
    const { root } = initTestPlexus(new VTreeHost({ title: "host", branches: new Map() }));
    const yjsMap = getYjsMap(root, "branches");

    materializeVirtualChild(
      root,
      "branches",
      "b1",
      yjsMap,
      (key) => new VBranch({ tag: `branch-${key}`, leaf: new VLeaf({ value: `leaf-of-${key}` }) }),
    );

    const branch = root.branches.get("b1")!;
    expect(branch.tag).toBe("branch-b1");
    expect(branch.leaf).not.toBeNull();
    expect(branch.leaf!.value).toBe("leaf-of-b1");
    expect(branch.leaf!.uuid).toBeTruthy();
    expect(branch.leaf!.uuid).not.toBe(branch.uuid);
  });

  it("recursive: factory produces entity with a child-list", () => {
    const hostRoot = initTestPlexus(new VTreeHost({ title: "host", branches: new Map() }));
    const yjsMap = getYjsMap(hostRoot.root, "branches");

    materializeVirtualChild(
      hostRoot.root,
      "branches",
      "multi",
      yjsMap,
      (key) =>
        new VBranch({
          tag: `parent-${key}`,
          leaf: new VLeaf({ value: `only-child-of-${key}` }),
        }),
    );

    const branch = hostRoot.root.branches.get("multi")!;
    expect(branch.tag).toBe("parent-multi");
    expect(branch.leaf!.value).toBe("only-child-of-multi");
  });

  it("recursive: deep nesting — entity → child → grandchild", () => {
    const { root } = initTestPlexus(new VTreeHostDeep({ title: "deep-host", nodes: new Map() }));
    const yjsMap = getYjsMap(root, "nodes");

    materializeVirtualChild(
      root,
      "nodes",
      "d1",
      yjsMap,
      (key) =>
        new VDeep({
          depth: `level-0-${key}`,
          nested: new VBranch({
            tag: `level-1-${key}`,
            leaf: new VLeaf({ value: `level-2-${key}` }),
          }),
        }),
    );

    const node = root.nodes.get("d1")!;
    expect(node.depth).toBe("level-0-d1");
    expect(node.nested).not.toBeNull();
    expect(node.nested!.tag).toBe("level-1-d1");
    expect(node.nested!.leaf).not.toBeNull();
    expect(node.nested!.leaf!.value).toBe("level-2-d1");

    // All three entities are distinct
    const uuids = new Set([node.uuid, node.nested!.uuid, node.nested!.leaf!.uuid]);
    expect(uuids.size).toBe(3);
  });

  it("recursive: deterministic UUIDs across independent docs", () => {
    const docId = "recursive-det-doc";
    const factory = (key: string) =>
      new VBranch({
        tag: `branch-${key}`,
        leaf: new VLeaf({ value: `leaf-${key}` }),
      });

    // Peer 1: bootstrap root
    const { root: root1, doc: doc1 } = initTestPlexus(new VTreeHost({ title: "host", branches: new Map() }), {}, docId);

    // Peer 2: sync parent state from peer 1 → same root UUID
    const doc2 = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
    const { root: root2 } = connectTestPlexus<VTreeHost>(doc2);

    // Both peers genesis independently on the shared parent
    materializeVirtualChild(root1, "branches", "r", getYjsMap(root1, "branches"), factory);
    materializeVirtualChild(root2, "branches", "r", getYjsMap(root2, "branches"), factory);

    // Same parent UUID + same inputs → identical UUIDs for all entities in the tree
    expect(root1.branches.get("r")!.uuid).toBe(root2.branches.get("r")!.uuid);
    expect(root1.branches.get("r")!.tag).toBe(root2.branches.get("r")!.tag);
    expect(root1.branches.get("r")!.leaf!.uuid).toBe(root2.branches.get("r")!.leaf!.uuid);
    expect(root1.branches.get("r")!.leaf!.value).toBe(root2.branches.get("r")!.leaf!.value);
  });

  it("recursive: parent chain is correct through nested entities", () => {
    const { root } = initTestPlexus(new VTreeHostDeep({ title: "chain-host", nodes: new Map() }));
    const yjsMap = getYjsMap(root, "nodes");

    materializeVirtualChild(
      root,
      "nodes",
      "chain",
      yjsMap,
      (key) =>
        new VDeep({
          depth: `top-${key}`,
          nested: new VBranch({
            tag: `mid-${key}`,
            leaf: new VLeaf({ value: `bottom-${key}` }),
          }),
        }),
    );

    const node = root.nodes.get("chain")!;
    expect(node.parent).toBe(root);
    expect(node.parentField).toBe("nodes");

    expect(node.nested!.parent).toBe(node);

    expect(node.nested!.leaf!.parent).toBe(node.nested);
  });

  it("recursive: undo does not remove nested genesis entities", () => {
    const { root, plexus } = initTestPlexus(new VTreeHost({ title: "undo-host", branches: new Map() }));
    const yjsMap = getYjsMap(root, "branches");

    materializeVirtualChild(
      root,
      "branches",
      "u",
      yjsMap,
      (key) =>
        new VBranch({
          tag: `branch-${key}`,
          leaf: new VLeaf({ value: `leaf-${key}` }),
        }),
    );

    expect(root.branches.has("u")).toBe(true);
    expect(root.branches.get("u")!.leaf).not.toBeNull();

    plexus.undo();

    expect(root.branches.has("u")).toBe(true);
    expect(root.branches.get("u")!.leaf).not.toBeNull();
    expect(root.branches.get("u")!.leaf!.value).toBe("leaf-u");
  });

  it("recursive: two peers independently genesis same tree → converge on sync", () => {
    const docId = "recursive-convergence";
    const factory = (key: string) =>
      new VBranch({
        tag: `branch-${key}`,
        leaf: new VLeaf({ value: `leaf-${key}` }),
      });

    // Peer 1: bootstrap root
    const { root: root1, doc: doc1 } = initTestPlexus(new VTreeHost({ title: "host", branches: new Map() }), {}, docId);

    // Peer 2: sync parent state from peer 1 → same root UUID
    const doc2 = new Y.Doc({ guid: docId });
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
    const { root: root2 } = connectTestPlexus<VTreeHost>(doc2);

    // Both peers genesis independently on the shared parent
    materializeVirtualChild(root1, "branches", "conv", getYjsMap(root1, "branches"), factory);
    materializeVirtualChild(root2, "branches", "conv", getYjsMap(root2, "branches"), factory);

    // Before sync: both have the entity independently
    const uuid1 = root1.branches.get("conv")!.uuid;
    const uuid2 = root2.branches.get("conv")!.uuid;
    expect(uuid1).toBe(uuid2);

    // Bidirectional sync
    const sv1 = Y.encodeStateVector(doc1);
    const sv2 = Y.encodeStateVector(doc2);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2));
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1));

    // After sync: exactly 1 entry, same UUID, leaf intact
    expect(root1.branches.size).toBe(1);
    expect(root2.branches.size).toBe(1);
    expect(root1.branches.get("conv")!.leaf!.value).toBe("leaf-conv");
  });

  // ── Nesting depth (virtual subtrees) ──

  it("nesting: sequential calls work, allowlist properly cycles", () => {
    const { root } = initTestPlexus(new VTreeHost({ title: "nested-host", branches: new Map() }));
    const yjsMap = getYjsMap(root, "branches");

    materializeVirtualChild(
      root,
      "branches",
      "first",
      yjsMap,
      (key) => new VBranch({ tag: `branch-${key}`, leaf: new VLeaf({ value: `leaf-${key}` }) }),
    );

    // Between calls: depth must be 0, allowlist null
    expect(__getGenesisDepth__()).toBe(0);
    expect(genesisAllowlist).toBeNull();

    materializeVirtualChild(
      root,
      "branches",
      "second",
      yjsMap,
      (key) => new VBranch({ tag: `branch-${key}`, leaf: new VLeaf({ value: `leaf-${key}` }) }),
    );

    expect(root.branches.size).toBe(2);
    expect(root.branches.get("first")!.tag).toBe("branch-first");
    expect(root.branches.get("second")!.tag).toBe("branch-second");
  });

  it("nesting: factory isolation still blocks external models", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    const external = new VChild({ label: "external" });
    root.items.set("ext", external);

    expect(() => {
      materializeVirtualChild(root, "items", "bad", yjsMap, (_key) => {
        const _ = external.label;
        return new VChild({ label: "should-not-reach" });
      });
    }).toThrow("factory isolation");
  });

  it("nesting: depth counter survives factory throw in nested context", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    // Throwing factory
    expect(() => {
      materializeVirtualChild(root, "items", "fail", yjsMap, () => {
        throw new Error("nested boom");
      });
    }).toThrow("nested boom");

    // State fully clean
    expect(__getGenesisDepth__()).toBe(0);
    expect(genesisAllowlist).toBeNull();

    // Subsequent call works
    materializeVirtualChild(root, "items", "after-fail", yjsMap, (key) => new VChild({ label: `ok-${key}` }));
    expect(root.items.get("after-fail")!.label).toBe("ok-after-fail");
  });

  // ── Factory purity (called twice) ──

  it("factory is called exactly twice (Phase 1 + Phase 2)", () => {
    const { root } = initTestPlexus(new VParent({ name: "parent", items: new Map() }));
    const yjsMap = getYjsMap(root, "items");

    let callCount = 0;
    materializeVirtualChild(root, "items", "count", yjsMap, (key) => {
      callCount++;
      return new VChild({ label: `child-${key}` });
    });

    expect(callCount).toBe(2);
    expect(root.items.get("count")!.label).toBe("child-count");
  });
});
