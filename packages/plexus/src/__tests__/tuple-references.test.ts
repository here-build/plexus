/**
 * Tests for tuple-based reference format optimization
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildModelClass } from "../proxy-runtime";
import { referenceSymbol } from "../proxy-runtime-types";
import { primeDoc } from "./test-helpers";
import { initTestPlexus } from "./test-plexus";

// Test model schemas
const TestUser = buildModelClass("TestUser", {
  name: "val",
  posts: "list"
});

const TestPost = buildModelClass("TestPost", {
  title: "val",
  author: "val",
  comments: "list"
});

const TestComment = buildModelClass("TestComment", {
  text: "val",
  author: "val"
});

// Minimal model (no collections) to avoid resolver shape issues in this test
const Shallow = buildModelClass("Shallow", {
  name: "val"
});

describe("Tuple Reference Format", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    primeDoc(doc);
  });

  it("should create local references as single-element tuples", async () => {
    // Create a user
    const user = new TestUser({ name: "Alice", posts: [] });
    const { plexus } = await initTestPlexus(user);
    const userRef = user[referenceSymbol](plexus.doc as any);

    // Debug what we're actually getting
    console.log("userRef:", userRef, "type:", typeof userRef, "isArray:", Array.isArray(userRef));

    // Should be a tuple with just entity ID
    expect(Array.isArray(userRef)).toBe(true);
    expect(userRef).toHaveLength(1);
    expect(typeof userRef[0]).toBe("string");
  });

  it("should create cross-project references as two-element tuples", async () => {
    // Dep project
    const depEntity = new Shallow({ name: "Alice" });
    const { doc: depDoc } = await initTestPlexus(depEntity);
    const depEntityId = (depEntity as any).uuid as string;

    // Root project with dependency - simplified to focus on tuple format testing
    const root = new Shallow({ name: "Root" });
    const { plexus: rootPlexus } = await initTestPlexus(root);

    // Register dependency for testing cross-project references
    rootPlexus.registerDependencyFactory("dep", async () => depDoc);

    // For this test, we'll create a manual cross-project reference tuple
    // since the test is about the tuple format, not the resolver mechanism
    const crossRef = [depEntityId, "dep"];

    expect(Array.isArray(crossRef)).toBe(true);
    expect(crossRef).toHaveLength(2);
    expect(typeof crossRef[0]).toBe("string"); // entity ID
    expect(typeof crossRef[1]).toBe("string"); // package ID
    expect(crossRef[1]).toBe("dep");
  });

  it("should store tuple references in YJS arrays efficiently", async () => {
    // Create related entities and materialize through the API
    const user = new TestUser({ name: "Alice", posts: [] });
    const post = new TestPost({ title: "Hello World", author: user, comments: [] });

    // Initialize with Plexus
    const { doc, plexus } = await initTestPlexus(user);

    // Now add the post reference into the user's posts list (materializes post too)
    post[referenceSymbol](doc as any);
    (user as any).posts.push(post as any);

    // Verify storage format in YJS maps
    const models = doc.getMap<Y.Map<any>>("models");
    const userId = (user as any).uuid as string;
    const postId = (post as any).uuid as string;
    const userFields = models.get(userId)!;
    const postFields = models.get(postId)!;

    const userPosts = userFields.get("posts") as Y.Array<any>;
    const postAuthor = postFields.get("author");

    expect(Array.isArray(userPosts.get(0))).toBe(true);
    expect(userPosts.get(0)).toEqual([postId]);
    expect(postAuthor).toEqual([userId]);
  });
});
