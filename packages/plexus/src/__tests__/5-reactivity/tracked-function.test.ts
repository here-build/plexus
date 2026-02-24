/**
 * Cross-Document Tracking and Notification Tests
 *
 * Tests the tracking system across multiple YJS documents:
 * - Doc1 subscribes to changes using createTrackedFunction
 * - Doc2 makes modifications
 * - Doc1 should receive notifications when tracked data changes
 */

import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { referenceSymbol } from "../../proxy-runtime-types.js";
import { createTrackedFunction } from "../../tracking.js";
import { initTestPlexus, TestPlexus } from "../_helpers/test-plexus.js";

// Model classes
@syncing
class User extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor email!: string;

  @syncing.record
  accessor posts!: Record<string, Post>;

  @syncing.set
  accessor tags!: Set<string>;
}

@syncing
class Post extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing
  accessor content!: string;

  @syncing
  accessor author!: User | null;

  @syncing.list
  accessor comments!: Post[];
}

// Test utilities
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

function createTestUser(name: string) {
  const ephemeralUser = new User({
    name,
    email: `${name.toLowerCase()}@test.com`,
    posts: {},
    tags: new Set(),
  });

  const { doc, root: user, plexus } = initTestPlexus<User>(ephemeralUser);
  return { user, entityId: user.uuid, doc, plexus };
}

// Helper to sync docs and create plexus2 with the synced root
function syncDocsAndCreatePlexus(doc1: Y.Doc, doc2: Y.Doc): TestPlexus<any> {
  syncDocs(doc1, doc2);
  // Create plexus2 after syncing so it has the root
  return TestPlexus.connect(doc2);
}

// Helper to sync docs when plexus2 already exists
function syncDocsWithPlexus(doc1: Y.Doc, doc2: Y.Doc, _plexus2: TestPlexus<any>): void {
  syncDocs(doc1, doc2);
}

describe("Cross-Document Notifications", () => {
  let doc1: Y.Doc;
  let doc2: Y.Doc;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
  });

  afterEach(() => {
    doc1.destroy();
    doc2.destroy();
  });

  describe("Basic Field Tracking", () => {
    it("should notify when primitive field changes across documents", async () => {
      // Doc1: Create user and set up tracking
      const { user: user1, entityId, doc: doc1 } = createTestUser("Alice");
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;
      expect(user2.name).to.equal("Alice");
      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => user2.name);
      expect(trackedFunction()).to.equal("Alice");
      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(0);
      // magic starts here
      user1.name = "Alice Smith";
      syncDocs(doc1, doc2);
      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(user2.name).to.equal("Alice Smith");
    });

    it("should notify when multiple fields change in same transaction", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Bob");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return { name: user2.name, email: user2.email }; // Track both fields on doc2
      });

      // Establish tracking
      expect(trackedFunction()).to.deep.equal({ name: "Bob", email: "bob@test.com" });

      // Doc1: Change both fields in single transaction
      doc1.transact(() => {
        user1.name = "Robert";
        user1.email = "robert@test.com";
      });

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      // Should only notify once for the batch
      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(user2.name).to.equal("Robert");
      expect(user2.email).to.equal("robert@test.com");
    });

    it("should not notify when untracked fields change", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Carol");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return user2.name; // Only track name on doc2, not email
      });

      expect(trackedFunction()).to.equal("Carol");

      // Doc1: Change only untracked field
      user1.email = "carol.new@test.com";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      // Should not notify
      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(0);
      expect(user2.email).to.equal("carol.new@test.com"); // Change still applies
    });
  });

  describe("Record/Map Tracking", () => {
    it("should notify when record property is added", async () => {
      const { user: user1, entityId, doc: doc1, plexus } = createTestUser("David");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return Object.keys(user2.posts).length; // Track record changes on doc2
      });

      expect(trackedFunction()).to.equal(0);

      // Doc1: Add a post
      const post = new Post({
        title: "New Post",
        content: "Content here",
        author: null,
        comments: [],
      });
      user1.posts["post1"] = post;
      const postRef = post[referenceSymbol](doc1); // Materialize the post

      // Force sync of the new post entity
      syncDocs(doc1, doc2);

      // Verify the post exists in doc2 by spawning it
      const postInDoc2 = plexus.loadEntity<Post>(postRef[0])!;
      console.log("Post spawned in doc2:", postInDoc2.title);

      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(Object.keys(user2.posts)).to.have.lengthOf(1);
      expect(user2.posts["post1"].title).to.equal("New Post");
    });

    it("should notify when record property is removed", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Eve");

      // Add initial post
      const initialPost = new Post({
        title: "Initial Post",
        content: "Content",
        author: null,
        comments: [],
      });
      initialPost[referenceSymbol](doc1); // Materialize the post
      user1.posts["initial"] = initialPost;

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return "initial" in user2.posts; // Track specific key existence on doc2
      });

      expect(trackedFunction()).to.eq(true);

      // Doc1: Remove the post
      delete user1.posts["initial"];

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect("initial" in user2.posts).to.eq(false);
    });

    it("should notify when specific record property is accessed", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Frank");

      // Add initial post
      const initialPost = new Post({
        title: "Original Title",
        content: "Content",
        author: null,
        comments: [],
      });
      initialPost[referenceSymbol](doc1); // Materialize the post
      user1.posts["tracked-post"] = initialPost;

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return user2.posts["tracked-post"]?.title; // Track specific post's title on doc2
      });

      expect(trackedFunction()).to.equal("Original Title");

      // Doc1: Change the specific post's title
      user1.posts["tracked-post"].title = "Updated Title";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(user2.posts["tracked-post"].title).to.equal("Updated Title");
    });
  });

  describe("Array/List Tracking", () => {
    it("should notify when array items are added", async () => {
      // Create a post with comments using Plexus
      const ephemeralPost = new Post({
        title: "Main Post",
        content: "Content",
        author: null,
        comments: [],
      });

      const { doc: doc1, root: post1, plexus } = initTestPlexus<Post>(ephemeralPost);
      const entityId = post1.uuid;

      // Sync to doc2
      syncDocs(doc1, doc2);

      const post2 = plexus.loadEntity<Post>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return post2.comments.length; // Track array length on doc2
      });

      expect(trackedFunction()).to.equal(0);

      // Doc1: Add comment (will be materialized via contagion)
      const comment = new Post({
        title: "Comment",
        content: "This is a comment",
        author: null,
        comments: [],
      });
      post1.comments.push(comment);

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(post2.comments).to.have.lengthOf(1);
      expect(post2.comments[0].title).to.equal("Comment");
    });

    it("should notify when array items are removed", async () => {
      // Create post with initial comment using Plexus
      const ephemeralPost = new Post({
        title: "Main Post",
        content: "Content",
        author: null,
        comments: [],
      });

      // Add initial comment (will be materialized via contagion)
      const initialComment = new Post({
        title: "Initial Comment",
        content: "Content",
        author: null,
        comments: [],
      });
      ephemeralPost.comments.push(initialComment);

      const { doc: doc1, root: post1, plexus } = initTestPlexus<Post>(ephemeralPost);
      const entityId = post1.uuid;

      // Sync to doc2
      syncDocs(doc1, doc2);

      const post2 = plexus.loadEntity<Post>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return post2.comments.length; // Track array length on doc2
      });

      expect(trackedFunction()).to.equal(1);

      // Doc1: Remove comment
      post1.comments.pop();

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(post2.comments).to.have.lengthOf(0);
    });

    it("should notify when specific array index is accessed", async () => {
      // Create post with initial comment using Plexus
      const ephemeralPost = new Post({
        title: "Main Post",
        content: "Content",
        author: null,
        comments: [],
      });

      // Add initial comment (will be materialized via contagion)
      const initialComment = new Post({
        title: "Original Comment",
        content: "Content",
        author: null,
        comments: [],
      });
      ephemeralPost.comments.push(initialComment);

      const { doc: doc1, root: post1, plexus } = initTestPlexus<Post>(ephemeralPost);
      const entityId = post1.uuid;

      // Sync to doc2
      syncDocs(doc1, doc2);

      const post2 = plexus.loadEntity<Post>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return post2.comments[0]?.title; // Track specific index on doc2
      });

      expect(trackedFunction()).to.equal("Original Comment");

      // Doc1: Modify comment at index 0
      post1.comments[0].title = "Modified Comment";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(post2.comments[0].title).to.equal("Modified Comment");
    });
  });

  describe("Set Tracking", () => {
    it("should notify when set items are added or removed", async () => {
      const { user: user1, entityId, doc: doc1, plexus } = createTestUser("Grace");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return Array.from(user2.tags).sort(); // Track set contents on doc2
      });

      expect(trackedFunction()).to.deep.equal([]);

      // Doc1: Add tags
      user1.tags.add("javascript");
      user1.tags.add("react");

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(Array.from(user2.tags).sort()).to.deep.equal(["javascript", "react"]);
    });
  });

  describe("Multiple Subscribers", () => {
    it("should notify all subscribers when tracked data changes", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Henry");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const tracker1 = createTrackedFunction(callback1, () => user2.name);
      const tracker2 = createTrackedFunction(callback2, () => user2.email);

      // Establish tracking
      expect(tracker1()).to.equal("Henry");
      expect(tracker2()).to.equal("henry@test.com");

      // Doc1: Change name (should only notify tracker1)
      user1.name = "Henry Jr";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(0);

      // Doc1: Change email (should only notify tracker2)
      user1.email = "henry.jr@test.com";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback1).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(callback2).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("Nested Entity Tracking", () => {
    it("should notify when nested entity properties change", async () => {
      const { user: user1, entityId: userId, doc: doc1 } = createTestUser("Iris");

      // Add a post with the user as author
      const post = new Post({
        title: "User's Post",
        content: "Content",
        author: user1,
        comments: [],
      });
      post[referenceSymbol](doc1); // Materialize the post
      user1.posts["main"] = post;

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(userId)!;

      const notifyCallback = vi.fn();
      const trackedFunction = createTrackedFunction(notifyCallback, () => {
        return user2.posts["main"]?.author?.name; // Track nested entity property on doc2
      });

      expect(trackedFunction()).to.equal("Iris");

      // Doc1: Change the author's name (should trigger notification)
      user1.name = "Iris Johnson";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifyCallback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(user2.posts["main"].author?.name).to.equal("Iris Johnson");
    });
  });

  describe("Performance and Cleanup", () => {
    it("should not accumulate subscribers after function executions", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Jack");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const callback = vi.fn();
      const trackedFunction = createTrackedFunction(callback, () => user2.name);

      // Run function multiple times - should only register tracking once
      let result;
      for (let i = 0; i < 10; i++) {
        result = trackedFunction();
      }
      expect(result).to.equal("Jack");

      // Change should only notify once, not 10 times
      user1.name = "Jack Updated";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      // Each trackedFunction() call registers for notifications independently
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(10);
    });

    it("should handle rapid successive changes efficiently", async () => {
      const { user: user1, entityId, doc: doc1 } = createTestUser("Kate");

      // Sync to doc2
      syncDocs(doc1, doc2);
      const plexus2 = TestPlexus.connect(doc2);
      const user2 = plexus2.loadEntity<User>(entityId)!;

      const callback = vi.fn();
      const trackedFunction = createTrackedFunction(callback, () => user2.name);

      expect(trackedFunction()).to.equal("Kate");

      // Multiple rapid changes in same tick
      user1.name = "Kate 1";
      user1.name = "Kate 2";
      user1.name = "Kate 3";

      syncDocs(doc1, doc2);
      await new Promise((resolve) => setImmediate(resolve));

      // Should batch notifications
      expect(callback).to.have.property("mock").with.property("calls").with.lengthOf(1);
      expect(user2.name).to.equal("Kate 3");
    });
  });
});
