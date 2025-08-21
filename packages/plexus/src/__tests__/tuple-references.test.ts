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

    const doc2 = new Y.Doc();
    (doc2 as any).rootProjectId = "project2";

    // Create user in project1
    const user = new TestUser({ name: "Alice", posts: [] });
    const entityId = "user_123";

    // Simulate materialization in project1
    user[referenceSymbol]("project1", doc1 as any);

    // Get reference from project2 (cross-project)
    const crossRef = user[referenceSymbol]("project2", doc2 as any);

    // Should be a tuple with entity ID and project ID
    expect(Array.isArray(crossRef)).toBe(true);
    expect(crossRef).toHaveLength(2);
    expect(typeof crossRef[0]).toBe("string"); // entity ID
    expect(typeof crossRef[1]).toBe("string"); // project ID
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

  it("should handle both legacy and tuple reference formats", () => {
    const projectModels = doc.getMap(`project:${projectId}:models`);
    const projectTypes = doc.getMap(`project:${projectId}:models:types`);

    // Set up entity types
    projectTypes.set("user_123", "TestUser");
    projectTypes.set("post_456", "TestPost");

    // Store legacy object reference
    projectModels.set("test.legacy", ["user_123"]);

    // Store new tuple reference
    projectModels.set("test.tuple", ["user_123"]);

    // Both should work when retrieved
    const legacyRef = projectModels.get("test.legacy");
    const tupleRef = projectModels.get("test.tuple");

    expect(legacyRef).toEqual({ __ref: "user_123" });
    expect(tupleRef).toEqual(["user_123"]);

    // Both formats should be valid references
    expect(typeof legacyRef).toBe("object");
    expect(Array.isArray(tupleRef)).toBe(true);
  });

  it("should serialize tuple references efficiently in JSON", () => {
    const legacyRef = { __ref: "entity_123" };
    const tupleRef = ["entity_123"];
    const crossProjectTuple = ["entity_123", "project_456"];

    // Compare JSON sizes
    const legacySize = JSON.stringify(legacyRef).length;
    const tupleSize = JSON.stringify(tupleRef).length;
    const crossProjectSize = JSON.stringify(crossProjectTuple).length;

    console.log("Reference sizes:", { legacySize, tupleSize, crossProjectSize });

    // Tuple format should be more compact
    expect(tupleSize).toBeLessThan(legacySize);

    // Even cross-project tuples should be comparable to legacy local refs
    expect(crossProjectSize).toBeLessThanOrEqual(legacySize * 1.5);
  });
});
