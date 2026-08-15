/**
 * Awareness read-half identity — reads resolve on the AUTHORING plane.
 *
 * The membrane's write half accepts family references (prime ↔ shadow); the
 * read half must be its mirror: deserializing a reference hands back the SAME
 * live instance the family's tree holds — not a second, prime-homed twin with
 * its own observers whose mutations bypass the authoring surface. Resolution
 * therefore targets the family's authoring doc (the shadow); docs outside any
 * Plexus family resolve against themselves, unchanged.
 *
 * Born red: deserialize used to deref against the awareness doc (prime),
 * materializing a duplicate instance per entity for every awareness reader.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyAwarenessUpdate, encodeAwarenessUpdate, PlexusAwareness } from "../../awareness.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("IdentItem")
class IdentItem extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("IdentHost")
class IdentHost extends PlexusModel {
  @syncing.child.list accessor items: IdentItem[] = [];
}

describe("awareness reads return the live family instance", () => {
  it("own-hub getField returns the tree instance itself", () => {
    const { plexus, root } = initTestPlexus(new IdentHost());
    const entity = new IdentItem({ name: "live" });
    root.items.push(entity);

    plexus.awareness.setField("ref", entity as never);
    expect(plexus.awareness.getField("ref")).toBe(entity);
  });

  it("a peer frame read via getPeer returns the tree instance", () => {
    const { plexus, root } = initTestPlexus(new IdentHost());
    const entity = new IdentItem({ name: "live" });
    root.items.push(entity);

    const author = new PlexusAwareness(plexus.doc, { clientId: 42_001 });
    author.setField("ref", entity as never);
    applyAwarenessUpdate(
      plexus.awareness,
      encodeAwarenessUpdate(author, [...author.states.keys()]),
      "remote",
    );

    const peer = plexus.awareness.getPeer(author.clientID) as { ref?: IdentItem };
    expect(peer?.ref).toBe(entity);
    author.destroy();
  });

  it("a remote replica resolves the reference to ITS family's instance", () => {
    const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new IdentHost());
    const entity = new IdentItem({ name: "shared" });
    rootA.items.push(entity);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { plexus: pB, root: rootB } = connectTestPlexus<IdentHost>(docB);

    pA.awareness.setField("ref", entity as never);
    const update = encodeAwarenessUpdate(pA.awareness, [...pA.awareness.states.keys()]);
    applyAwarenessUpdate(pB.awareness, update, "remote");

    const read = (pB.awareness.getPeer(pA.awareness.clientID) as { ref?: IdentItem })?.ref;
    expect(read).toBeInstanceOf(IdentItem);
    expect(read!.uuid).toBe(entity.uuid);
    // The receiver's read IS the receiver's tree instance — one identity per family.
    expect(read).toBe(rootB.items[0]);
    // Mutation through the read writes through the authoring surface.
    read!.name = "renamed";
    expect(rootB.items[0]!.name).toBe("renamed");
  });
});
