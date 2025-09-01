import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TestPlexus, initTestPlexus } from "./test-plexus.js";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";

type Root = ModelType<{ name: string }, "Root">;
const Root = buildModelClass<Root>("Root", { name: "val" });

describe("Plexus singleton per Y.Doc", () => {
  it("throws if constructed twice for the same document", async () => {
    const rootEntity = new Root({ name: "r" });
    const { doc } = await initTestPlexus<Root>(rootEntity);

    // Second instance should fail immediately on constructor
    expect(() => new TestPlexus<any>(doc)).toThrow();
  });
});
