import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { loadEntity } from "../load.js";
import { YJS_GLOBALS } from "../YJS_GLOBALS.js";
import { primeDoc } from "./test-helpers.js";

// Test models
type UserType = ModelType<
  {
    name: string;
    email: string;
    age: number;
  },
  "User"
>;

type PostType = ModelType<
  {
    title: string;
    content: string;
    author: UserType | null;
    tags: string[];
  },
  "Post"
>;

type CommentType = ModelType<
  {
    text: string;
    author: UserType | null;
    post: PostType | null;
  },
  "Comment"
>;

const User = buildModelClass<UserType>("User", {
  name: "val",
  email: "val",
  age: "val"
});

const Post = buildModelClass<PostType>("Post", {
  title: "val",
  content: "val",
  author: "val",
  tags: "list"
});

const Comment = buildModelClass<CommentType>("Comment", {
  text: "val",
  author: "val",
  post: "val"
});

describe("loadEntity", () => {
  let doc: Y.Doc;
  let userId: string;
  let postId: string;
  let commentId: string;

  beforeEach(() => {
    doc = new Y.Doc();
    primeDoc(doc); // Register the doc as a legitimate Plexus root
    
    // Create and materialize test entities
    const user = new User({
      name: "John Doe",
      email: "john@example.com",
      age: 30
    });
    const [uid] = (user as any)[referenceSymbol](doc);
    userId = uid;

    const post = new Post({
      title: "Test Post",
      content: "This is a test post",
      author: user,
      tags: ["test", "plexus"]
    });
    const [pid] = (post as any)[referenceSymbol](doc);
    postId = pid;

    const comment = new Comment({
      text: "Great post!",
      author: user,
      post: post
    });
    const [cid] = (comment as any)[referenceSymbol](doc);
    commentId = cid;
  });

  describe("basic loading", () => {
    it("should load an existing entity by ID", () => {
      const loadedUser = loadEntity<UserType>(doc, userId);
      
      expect(loadedUser).not.toBeNull();
      expect(loadedUser!.name).toBe("John Doe");
      expect(loadedUser!.email).toBe("john@example.com");
      expect(loadedUser!.age).toBe(30);
      expect(loadedUser!.uuid).toBe(userId);
    });

    it("should return null for non-existent entity", () => {
      const nonExistent = loadEntity<UserType>(doc, "non-existent-id");
      
      expect(nonExistent).toBeNull();
    });

    it("should load entities with different types", () => {
      const loadedPost = loadEntity<PostType>(doc, postId);
      const loadedComment = loadEntity<CommentType>(doc, commentId);
      
      expect(loadedPost).not.toBeNull();
      expect(loadedPost!.title).toBe("Test Post");
      expect(loadedPost!.content).toBe("This is a test post");
      
      expect(loadedComment).not.toBeNull();
      expect(loadedComment!.text).toBe("Great post!");
    });
  });

  describe("loading with relationships", () => {
    it("should load entity with references to other entities", () => {
      const loadedPost = loadEntity<PostType>(doc, postId);
      
      expect(loadedPost).not.toBeNull();
      expect(loadedPost!.author).not.toBeNull();
      expect(loadedPost!.author!.name).toBe("John Doe");
      expect(loadedPost!.author!.uuid).toBe(userId);
    });

    it("should load entity with collection fields", () => {
      const loadedPost = loadEntity<PostType>(doc, postId);
      
      expect(loadedPost).not.toBeNull();
      expect(loadedPost!.tags).toHaveLength(2);
      expect(loadedPost!.tags[0]).toBe("test");
      expect(loadedPost!.tags[1]).toBe("plexus");
    });

    it("should handle null references correctly", () => {
      // Create a post without an author
      const orphanPost = new Post({
        title: "Orphan Post",
        content: "No author",
        author: null,
        tags: []
      });
      const [orphanId] = (orphanPost as any)[referenceSymbol](doc);
      
      const loadedOrphan = loadEntity<PostType>(doc, orphanId);
      
      expect(loadedOrphan).not.toBeNull();
      expect(loadedOrphan!.author).toBeNull();
      expect(loadedOrphan!.tags).toHaveLength(0);
    });
  });

  describe("entity mutations after loading", () => {
    it("should reflect mutations made to loaded entity", () => {
      const loadedUser = loadEntity<UserType>(doc, userId);
      
      expect(loadedUser).not.toBeNull();
      expect(loadedUser!.name).toBe("John Doe");
      
      // Mutate the loaded entity
      loadedUser!.name = "Jane Doe";
      loadedUser!.age = 31;
      
      // Load again and verify mutations are persisted
      const reloadedUser = loadEntity<UserType>(doc, userId);
      expect(reloadedUser!.name).toBe("Jane Doe");
      expect(reloadedUser!.age).toBe(31);
    });

    it("should handle mutations to collection fields", () => {
      const loadedPost = loadEntity<PostType>(doc, postId);
      
      expect(loadedPost).not.toBeNull();
      expect(loadedPost!.tags).toHaveLength(2);
      
      // Mutate the tags array
      loadedPost!.tags.push("new-tag");
      
      // Load again and verify mutation is persisted
      const reloadedPost = loadEntity<PostType>(doc, postId);
      expect(reloadedPost!.tags).toHaveLength(3);
      expect(reloadedPost!.tags[2]).toBe("new-tag");
    });
  });

  describe("type inference", () => {
    it("should correctly infer entity type from generic parameter", () => {
      const user = loadEntity<UserType>(doc, userId);
      const post = loadEntity<PostType>(doc, postId);
      const comment = loadEntity<CommentType>(doc, commentId);
      
      // TypeScript should correctly infer these types
      // These assertions would fail at compile time if types were wrong
      if (user) {
        const _name: string = user.name;
        const _email: string = user.email;
        const _age: number = user.age;
      }
      
      if (post) {
        const _title: string = post.title;
        const _author: UserType | null = post.author;
        const _tags: string[] = post.tags;
      }
      
      if (comment) {
        const _text: string = comment.text;
        const _author: UserType | null = comment.author;
        const _post: PostType | null = comment.post;
      }
      
      expect(true).toBe(true); // Just to have an assertion
    });
  });

  describe("edge cases", () => {
    it("should handle loading the same entity multiple times", () => {
      const firstLoad = loadEntity<UserType>(doc, userId);
      const secondLoad = loadEntity<UserType>(doc, userId);
      
      expect(firstLoad).not.toBeNull();
      expect(secondLoad).not.toBeNull();
      
      // Should return the same entity instance
      expect(firstLoad).toBe(secondLoad);
      expect(firstLoad!.uuid).toBe(secondLoad!.uuid);
    });

    it("should handle empty document", () => {
      const emptyDoc = new Y.Doc();
      primeDoc(emptyDoc); // Register the doc as legitimate
      const result = loadEntity<UserType>(emptyDoc, "any-id");
      
      expect(result).toBeNull();
    });

    it("should handle loading entity that was deleted", () => {
      // First verify entity exists
      const user = loadEntity<UserType>(doc, userId);
      expect(user).not.toBeNull();
      
      // Delete the entity from the document
      doc.getMap(YJS_GLOBALS.models).delete(userId);
      
      // Try to load deleted entity
      const deletedUser = loadEntity<UserType>(doc, userId);
      expect(deletedUser).toBeNull();
    });

    it("should handle entity with missing type metadata", () => {
      // Create a malformed entity directly in YJS without proper metadata
      const malformedId = "malformed-entity";
      const malformedData = new Y.Map();
      malformedData.set("name", "Malformed");
      // Intentionally not setting YJS_GLOBALS.modelMetadataType
      doc.getMap(YJS_GLOBALS.models).set(malformedId, malformedData);
      
      // Should return null for malformed entity
      const result = loadEntity<UserType>(doc, malformedId);
      expect(result).toBeNull();
    });
  });

  describe("circular references", () => {
    it("should handle circular references between entities", () => {
      // Create posts that reference each other through comments
      const post1 = new Post({
        title: "Post 1",
        content: "Content 1",
        author: null,
        tags: []
      });
      const [p1id] = (post1 as any)[referenceSymbol](doc);
      
      const post2 = new Post({
        title: "Post 2",
        content: "Content 2",
        author: null,
        tags: []
      });
      const [p2id] = (post2 as any)[referenceSymbol](doc);
      
      // Create comments that create a circular reference
      const comment1 = new Comment({
        text: "Comment on post 1",
        author: null,
        post: post1
      });
      const [c1id] = (comment1 as any)[referenceSymbol](doc);
      
      const comment2 = new Comment({
        text: "Comment on post 2",
        author: null,
        post: post2
      });
      (comment2 as any)[referenceSymbol](doc);
      
      // Load and verify circular structure is handled
      const loadedPost1 = loadEntity<PostType>(doc, p1id);
      const loadedComment1 = loadEntity<CommentType>(doc, c1id);
      
      expect(loadedPost1).not.toBeNull();
      expect(loadedComment1).not.toBeNull();
      expect(loadedComment1!.post).toBe(loadedPost1);
    });
  });
});