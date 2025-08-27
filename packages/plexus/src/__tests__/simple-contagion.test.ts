/**
 * Minimal test to debug contagion system
 */

import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProxyEntity, referenceSymbol } from "../";

import { type ModelType } from "../proxy-runtime-types.js";
import { buildModelClass } from "../proxy-runtime.js";

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

import { load } from "../load";
import { primeDoc, storeAsRoot } from "./test-helpers";

describe("Simple Contagion Test", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    primeDoc(doc);
  });

  afterEach(() => {
    doc.destroy();
  });

  it("should materialize ephemeral entity and allow spawn", () => {
    // Step 1: Create ephemeral site
    const ephemeralSite = new Site({ name: "Test Site", components: {} });
    expect((ephemeralSite as any)[isProxyEntity]).toBe(true);
    expect(ephemeralSite.name).toBe("Test Site");

    console.log("1. Created ephemeral site");

    // Step 2: Materialize it to YJS
    const siteRef = (ephemeralSite as any)[referenceSymbol](doc);
    const entityId = siteRef[0];

    console.log("2. Materialized site, entityId:", entityId);
    console.log("3. Site ref:", siteRef);

    // Mark as root for loader-based flow and load it
    storeAsRoot(doc, ephemeralSite as any);
    const spawnedSite = load<SiteType>(doc);
    expect(spawnedSite.name).toBe("Test Site");

    console.log("4. Successfully spawned site");

    // Step 4: Create ephemeral component
    const ephemeralComponent = new Component({ name: "Header" });
    expect(ephemeralComponent.name).toBe("Header");

    console.log("5. Created ephemeral component");

    // Step 5: Trigger contagion by adding to site
    spawnedSite.components["header"] = ephemeralComponent;

    console.log("6. Added component to site");

    // Step 6: Verify component is accessible
    const retrievedComponent = spawnedSite.components["header"];
    console.log("7. Retrieved component:", retrievedComponent);
    console.log("8. Retrieved component name:", retrievedComponent.name);

    expect(retrievedComponent).toBeTruthy();
    expect(retrievedComponent.name).toBe("Header");
  });
});
