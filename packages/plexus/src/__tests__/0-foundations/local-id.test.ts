/**
 * .localID — process-local creation-order identity
 *
 * Covers the contract of `src/local-id.ts` + the eager mint in the
 * PlexusModel constructor:
 *   - creation-order monotonicity, across model classes
 *   - resetLocalIDs() restarts the counter at 1
 *   - ephemeral (doc-less) entities have a localID; .uuid contrast
 *   - localID survives materialization unchanged
 *   - clones are new entities → fresh localID
 *   - localID never reaches any serialized representation
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { resetLocalIDs } from "../../local-id.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { getModelsMap } from "../getModelsMap.js";

@syncing("LocalIdNode")
class LocalIdNode extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.list
  accessor kids!: any[];
}

@syncing("LocalIdLeaf")
class LocalIdLeaf extends PlexusModel {
  @syncing
  accessor label!: string;
}

describe("PlexusModel.localID", () => {
  it("resetLocalIDs() restarts the counter — first entity after reset gets 1", () => {
    resetLocalIDs();
    const first = new LocalIdNode({ name: "first", kids: [] });
    const second = new LocalIdLeaf({ label: "second" });
    const third = new LocalIdNode({ name: "third", kids: [] });
    expect([first.localID, second.localID, third.localID]).toEqual([1, 2, 3]);
  });

  it("is minted in creation order, monotonically, across different model classes", () => {
    const a = new LocalIdNode({ name: "a", kids: [] });
    const b = new LocalIdLeaf({ label: "b" });
    const c = new LocalIdNode({ name: "c", kids: [] });
    expect(a.localID).toBeLessThan(b.localID);
    expect(b.localID).toBeLessThan(c.localID);
  });

  it("exists on ephemeral (doc-less) entities and reading it does not throw", () => {
    const ephemeral = new LocalIdLeaf({ label: "ghost" });
    expect(typeof ephemeral.localID).toBe("number");
    expect(Number.isInteger(ephemeral.localID)).toBe(true);
  });

  it(".uuid on the same doc-less entity throws (contrast: localID is construction-time)", () => {
    const ephemeral = new LocalIdLeaf({ label: "ghost" });
    expect(() => ephemeral.uuid).toThrowError(/accessed before materialization/);
    expect(typeof ephemeral.localID).toBe("number");
  });

  it("is unchanged when an ephemeral entity later materializes", () => {
    const root = new LocalIdNode({ name: "root", kids: [] });
    initTestPlexus(root);

    const kid = new LocalIdLeaf({ label: "kid" });
    const before = kid.localID;

    root.kids.push(kid); // materializes kid into root's doc
    expect(kid.uuid).toBeTruthy(); // now doc-backed
    expect(kid.localID).toBe(before);
  });

  it("clone() is a new entity — fresh localID, never copied", () => {
    const root = new LocalIdNode({ name: "root", kids: [] });
    initTestPlexus(root);
    const source = new LocalIdLeaf({ label: "original" });
    root.kids.push(source);

    const copy = source.clone() as LocalIdLeaf;
    expect(copy.label).toBe("original");
    expect(copy.localID).toBeGreaterThan(source.localID);
  });

  it("never reaches any serialized representation", () => {
    const root = new LocalIdNode({ name: "root", kids: [] });
    const { doc } = initTestPlexus(root);
    const kid = new LocalIdLeaf({ label: "kid" });
    root.kids.push(kid);

    // toJSON: schema keys only
    expect(Object.keys(root.toJSON())).toEqual(["name", "kids"]);
    expect(Object.keys(kid.toJSON())).toEqual(["label"]);

    // yjs entity node: attribute names are schema fields, never localID
    const models = getModelsMap(doc);
    for (const uuid of [root.uuid, kid.uuid]) {
      const node = models.get(uuid);
      expect(node).toBeDefined();
      expect(Object.keys(node!.getAttributes())).not.toContain("localID");
    }

    // whole-doc sweep: attribute/key names appear as plaintext in yjs updates,
    // so the encoded state must not contain the string at all
    const wire = new TextDecoder().decode(Y.encodeStateAsUpdate(doc));
    expect(wire).toContain("label"); // sanity: schema names DO appear
    expect(wire).not.toContain("localID");
  });
});
