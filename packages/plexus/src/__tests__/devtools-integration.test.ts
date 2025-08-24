import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";

describe("DevTools Integration", () => {
  type TestModelType = ModelType<
    {
      name: string;
      count: number;
    },
    "TestModel"
  >;

  const TestModel = buildModelClass<TestModelType>("TestModel", {
    name: "val",
    count: "val"
  });
  let obj: TestModelType;

  beforeEach(() => {
    obj = new TestModel({
      name: "test",
      count: 5
    });
  });

  it("should collect mutations in development mode", async () => {
    // Mock Redux DevTools
    const mockDevTools = {
      send: vi.fn()
    };

    const mockReduxDevTools = {
      connect: vi.fn(() => mockDevTools)
    };

    // Mock window and Redux DevTools extension
    const originalWindow = global.window;
    global.window = {
      ...global.window,
      __REDUX_DEVTOOLS_EXTENSION__: mockReduxDevTools
    } as any;

    // Mock NODE_ENV to enable DevTools
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      // Make some mutations
      obj.name = "changed";
      obj.count = 42;

      // Wait for batch to flush (setImmediate)
      await new Promise((resolve) => setImmediate(resolve));

      // Verify DevTools was called
      expect(mockReduxDevTools.connect).toHaveBeenCalled();
      expect(mockDevTools.send).toHaveBeenCalledWith(
        {
          type: "PLEXUS_BATCH_UPDATE",
          payload: {
            mutations: expect.any(Array),
            count: 2
          }
        },
        { mutations: expect.any(Array) }
      );

      // Check mutation details
      const [action, state] = mockDevTools.send.mock.calls[0];
      expect(action.payload.mutations).toHaveLength(2);
      expect(action.payload.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "name",
            value: "changed"
          }),
          expect.objectContaining({
            field: "count",
            value: 42
          })
        ])
      );
    } finally {
      // Restore environment
      global.window = originalWindow;
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("should not collect mutations in production mode", async () => {
    // Mock Redux DevTools
    const mockDevTools = {
      send: vi.fn()
    };

    const mockReduxDevTools = {
      connect: vi.fn(() => mockDevTools)
    };

    global.window = {
      ...global.window,
      __REDUX_DEVTOOLS_EXTENSION__: mockReduxDevTools
    } as any;

    // Set production mode
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      // Make mutations
      obj.name = "changed";
      obj.count = 42;

      // Wait for potential batch
      await new Promise((resolve) => setImmediate(resolve));

      // DevTools should not be called in production
      expect(mockDevTools.send).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
