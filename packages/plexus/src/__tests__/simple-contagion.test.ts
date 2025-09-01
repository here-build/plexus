/**
 * Minimal test to debug contagion system
 */

import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProxyEntity } from "../";

import { type ModelType } from "../proxy-runtime-types.js";
import { buildModelClass } from "../proxy-runtime.js";
import { initTestPlexus } from "./test-plexus.js";

// Extended Y.Doc type for testing
type TestYDoc = Y.Doc;

type ComponentType = ModelType<
  {
    name: string;
  },
  "Component"
>;

type SiteType = ModelType<
  {
    name: string;
    readonly components: Record<string, ComponentType>;
  },
  "Site"
>;

// Simple test schema
const Component = buildModelClass<ComponentType>("Component", {
  name: "val"
});

const Site = buildModelClass<SiteType>("Site", {
  name: "val",
  components: "record"
});

describe("Simple Contagion Test", () => {
  let doc: Y.Doc;
  let spawnedSite: SiteType;

  beforeEach(async () => {
    // Step 1: Create ephemeral site
    const ephemeralSite = new Site({ name: "Test Site", components: {} });

    // Step 2: Initialize with Plexus
    const result = await initTestPlexus<SiteType>(ephemeralSite);
    doc = result.doc;
    spawnedSite = result.root;

    console.log("1. Created and loaded site via Plexus");
  });

  afterEach(() => {
    doc?.destroy();
  });

  it("should materialize ephemeral entity and allow spawn", () => {
    // Verify initial site state
    expect(spawnedSite.name).toBe("Test Site");
    expect((spawnedSite as any)[isProxyEntity]).toBe(true);

    console.log("2. Verified site loaded correctly");

    // Step 3: Create ephemeral component
    const ephemeralComponent = new Component({ name: "Header" });
    expect(ephemeralComponent.name).toBe("Header");

    console.log("3. Created ephemeral component");

    // Step 4: Trigger contagion by adding to site
    spawnedSite.components["header"] = ephemeralComponent;

    console.log("4. Added component to site");

    // Step 5: Verify component is accessible
    const retrievedComponent = spawnedSite.components["header"];
    console.log("5. Retrieved component:", retrievedComponent);
    console.log("6. Retrieved component name:", retrievedComponent.name);

    expect(retrievedComponent).toBeTruthy();
    expect(retrievedComponent.name).toBe("Header");
  });
});
