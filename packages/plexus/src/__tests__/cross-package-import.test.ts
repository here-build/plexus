import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelClass, createTrackedFunction } from "../index.js";
import type { ModelType } from "../proxy-runtime-types.js";

describe("Cross Package Import Test", () => {
  type TestModelType = ModelType<
    {
      name: string;
    },
    "TestModel"
  >;

  let TestModel: ReturnType<typeof buildModelClass<TestModelType>>;
  let obj: TestModelType;

  beforeEach(() => {
    TestModel = buildModelClass<TestModelType>("TestModel", {
      name: "val"
    });

    obj = new TestModel({
      name: "test"
    });
  });

  it("should work when imported from index", () => {
    const callback = vi.fn();

    const trackedFn = createTrackedFunction(callback, () => obj.name);

    expect(trackedFn()).toBe("test");
    expect(callback).toHaveBeenCalledTimes(0);

    obj.name = "changed";
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
