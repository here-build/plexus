/**
 * Tests for tuple-based reference format optimization
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { buildModelClass } from "../proxy-runtime";
import { referenceSymbol } from "../proxy-runtime-types";

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

describe("Tuple Reference Format", () => {
  let doc: Y.Doc;
  const projectId = "test-project";

  beforeEach(() => {
    doc = new Y.Doc();
    (doc as any).rootProjectId = projectId;
  });

  it("should create local references as single-element tuples", () => {
    // Create a user
    const user = new TestUser({ name: "Alice", posts: [] });
    const userRef = user[referenceSymbol](projectId, doc as any);

    // Debug what we're actually getting
    console.log("userRef:", userRef, "type:", typeof userRef, "isArray:", Array.isArray(userRef));

    // Should be a tuple with just entity ID
    expect(Array.isArray(userRef)).toBe(true);
    expect(userRef).toHaveLength(1);
    expect(typeof userRef[0]).toBe("string");
  });

  it("should create cross-project references as two-element tuples", () => {
    const doc1 = new Y.Doc();
    (doc1 as any).rootProjectId = "project1";

    // Create user in project1
    const user = new TestUser({ name: "Alice", posts: [] });

    // Simulate materialization in project1
    user[referenceSymbol]("project1", doc1 as any);

    // Get reference for project2 (cross-project) using the same document but different target project
    const crossRef = user[referenceSymbol]("project2", doc1 as any);

    // Should be a tuple with entity ID and project ID
    expect(Array.isArray(crossRef)).toBe(true);
    expect(crossRef).toHaveLength(2);
    expect(typeof crossRef[0]).toBe("string"); // entity ID
    expect(typeof crossRef[1]).toBe("string"); // project ID (should be "project1")
    expect(crossRef[1]).toBe("project1"); // The project ID where the entity is materialized
  });

  it("should store tuple references in YJS arrays efficiently", () => {
    // Create related entities
    const user = new TestUser({ name: "Alice", posts: [] });
    const post = new TestPost({ title: "Hello World", author: user, comments: [] });

    // Materialize entities
    const userId = "user_123";
    const postId = "post_456";

    // Simulate storing in YJS with tuple references
    const projectModels = doc.getMap(`project:${projectId}:models`);
    const projectTypes = doc.getMap(`project:${projectId}:models:types`);

    // Store types
    projectTypes.set(userId, "TestUser");
    projectTypes.set(postId, "TestPost");

    // Store user with posts array containing tuple reference
    projectModels.set(`${userId}.name`, "Alice");
    projectModels.set(`${userId}.posts`, Y.Array.from([[postId]])); // Tuple reference

    // Store post with author tuple reference
    projectModels.set(`${postId}.title`, "Hello World");
    projectModels.set(`${postId}.author`, [userId]); // Tuple reference
    projectModels.set(`${postId}.comments`, Y.Array.from([]));

    // Verify storage format
    const userPosts = projectModels.get(`${userId}.posts`) as Y.Array<any>;
    const postAuthor = projectModels.get(`${postId}.author`);

    expect(userPosts.get(0)).toEqual([postId]);
    expect(postAuthor).toEqual([userId]);
  });
});
