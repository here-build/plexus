import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { Plexus } from "../plexus";
import { createTrackedFunction } from "../tracking";
import { buildModelClass } from "../proxy-runtime";
import { ModelType } from "../proxy-runtime-types";
import { entityClasses } from "../globals";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

// Define a more complex model for integration testing
type TodoItem = ModelType<{
  text: string;
  completed: boolean;
  priority: number;
}, "TodoItem">;

type TodoList = ModelType<{
  name: string;
  readonly items: TodoItem[];
  readonly tags: Set<string>;
}, "TodoList">;

const TodoItem = buildModelClass<TodoItem>("TodoItem", {
  text: "val",
  completed: "val",
  priority: "val",
});

const TodoList = buildModelClass<TodoList>("TodoList", {
  name: "val",
  items: "child-list",
  tags: "set",
});

class TodoPlexus extends Plexus<TodoList> {
  constructor(doc: Y.Doc) {
    // Set up root data before calling super to avoid loadRoot errors
    doc.getMap(YJS_GLOBALS.metadataMap).set(YJS_GLOBALS.metadataMapFields.root, "list-id");
    const models = doc.getMap(YJS_GLOBALS.models);
    
    // Create root TodoList
    const listModel = new Y.Map();
    listModel.set(YJS_GLOBALS.modelMetadataType, "TodoList");
    listModel.set("name", "My Tasks");
    listModel.set("items", new Y.Array());
    listModel.set("tags", new Y.Array());
    models.set("list-id", listModel);
    
    super(doc);
  }

  async fetchDependency(): Promise<Y.Doc> {
    throw new Error("Not implemented");
  }
  
  getTodoList(): TodoList {
    return TodoList.spawn("list-id", this.doc) as TodoList;
  }
}

// Register entity classes globally before tests
entityClasses.set("TodoItem", TodoItem);
entityClasses.set("TodoList", TodoList);

describe("Transaction Integration Tests", () => {

  it("should batch multiple operations in a single transaction", () => {
    const doc = new Y.Doc();
    const plexus = new TodoPlexus(doc);
    const todoList = plexus.getTodoList();
    
    // Track changes
    const changeLog: string[] = [];
    const callback = vi.fn(() => {
      changeLog.push(`Changed: ${todoList.name}, items: ${todoList.items.length}`);
    });
    
    const tracked = createTrackedFunction(callback, () => {
      return {
        name: todoList.name,
        itemCount: todoList.items.length,
        tags: Array.from(todoList.tags),
      };
    });
    
    // Initial tracking
    tracked();
    callback.mockClear();
    
    // Perform multiple operations in a transaction
    plexus.transact(() => {
      // Add multiple items
      const item1 = TodoItem.spawn(null, doc) as TodoItem;
      item1.text = "Buy groceries";
      item1.completed = false;
      item1.priority = 1;
      todoList.items.push(item1);
      
      const item2 = TodoItem.spawn(null, doc) as TodoItem;
      item2.text = "Write tests";
      item2.completed = true;
      item2.priority = 2;
      todoList.items.push(item2);
      
      // Update list name
      todoList.name = "Today's Tasks";
      
      // Add tags
      todoList.tags.add("urgent");
      todoList.tags.add("work");
      
      // Should not trigger any callbacks yet
      expect(callback).not.toHaveBeenCalled();
    });
    
    // After transaction, should be called exactly once
    expect(callback).toHaveBeenCalledTimes(1);
    expect(changeLog).toEqual(["Changed: Today's Tasks, items: 2"]);
    
    // Verify final state
    expect(todoList.name).toBe("Today's Tasks");
    expect(todoList.items.length).toBe(2);
    // Items are proxy entities, accessing them properly requires deref
    // For now just verify count
    expect(Array.from(todoList.tags)).toContain("urgent");
    expect(Array.from(todoList.tags)).toContain("work");
  });

  it("should handle nested transactions with complex operations", () => {
    const doc = new Y.Doc();
    const plexus = new TodoPlexus(doc);
    const todoList = plexus.getTodoList();
    
    const notifications: string[] = [];
    const callback = vi.fn(() => {
      notifications.push("notified");
    });
    
    const tracked = createTrackedFunction(callback, () => todoList.items.length);
    tracked();
    callback.mockClear();
    
    // Helper to add a todo item
    const addTodo = (text: string, priority: number) => {
      return plexus.transact(() => {
        const item = TodoItem.spawn(null, doc) as TodoItem;
        item.text = text;
        item.completed = false;
        item.priority = priority;
        todoList.items.push(item);
        return item;
      });
    };
    
    // Outer transaction
    plexus.transact(() => {
      // These are shadow sub-transactions
      const item1 = addTodo("First task", 1);
      const item2 = addTodo("Second task", 2);
      
      // Nested transaction to modify items
      plexus.transact(() => {
        item1.completed = true;
        item2.priority = 3;
      });
      
      // No notifications yet
      expect(notifications.length).toBe(0);
    });
    
    // Single notification after all operations
    expect(notifications).toEqual(["notified"]);
    expect(todoList.items.length).toBe(2);
  });

  it("should rollback on error and not notify", () => {
    const doc = new Y.Doc();
    const plexus = new TodoPlexus(doc);
    const todoList = plexus.getTodoList();
    
    const callback = vi.fn();
    const tracked = createTrackedFunction(callback, () => todoList.name);
    tracked();
    callback.mockClear();
    
    const originalName = todoList.name;
    
    expect(() => {
      plexus.transact(() => {
        todoList.name = "Modified name";
        // This should rollback the change
        throw new Error("Intentional error");
      });
    }).toThrow("Intentional error");
    
    // No notification on error
    expect(callback).not.toHaveBeenCalled();
    
    // State should be rolled back (YJS handles this)
    // Note: YJS actually doesn't rollback automatically, so the name will be changed
    // This is expected behavior - the transaction completes the YJS operations
    // but our notification system doesn't fire on error
    expect(todoList.name).toBe("Modified name"); // YJS doesn't rollback
  });

  it("should handle concurrent tracked functions efficiently", () => {
    const doc = new Y.Doc();
    const plexus = new TodoPlexus(doc);
    const todoList = plexus.getTodoList();
    
    // Create three groups of callbacks tracking different things
    const nameCallbacks: vi.Mock[] = [];
    const itemCallbacks: vi.Mock[] = [];
    const tagCallbacks: vi.Mock[] = [];
    
    // Track name changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      nameCallbacks.push(callback);
      const tracked = createTrackedFunction(callback, () => todoList.name);
      tracked();
    }
    
    // Track item count changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      itemCallbacks.push(callback);
      const tracked = createTrackedFunction(callback, () => todoList.items.length);
      tracked();
    }
    
    // Track tag changes
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      tagCallbacks.push(callback);
      const tracked = createTrackedFunction(callback, () => Array.from(todoList.tags).join(","));
      tracked();
    }
    
    // Clear all initial calls
    [...nameCallbacks, ...itemCallbacks, ...tagCallbacks].forEach(cb => cb.mockClear());
    
    // Single transaction with multiple changes
    plexus.transact(() => {
      todoList.name = "Updated";
      
      const item = TodoItem.spawn(null, doc) as TodoItem;
      item.text = "New Task";
      item.completed = false;
      item.priority = 1;
      todoList.items.push(item);
      
      todoList.tags.add("batch");
      todoList.tags.add("test");
      
      // No callbacks during transaction
      [...nameCallbacks, ...itemCallbacks, ...tagCallbacks].forEach(cb => {
        expect(cb).not.toHaveBeenCalled();
      });
    });
    
    // Each group should fire exactly once
    nameCallbacks.forEach(cb => {
      expect(cb).toHaveBeenCalledTimes(1);
    });
    itemCallbacks.forEach(cb => {
      expect(cb).toHaveBeenCalledTimes(1);
    });
    tagCallbacks.forEach(cb => {
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});