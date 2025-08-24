/**
 * Minimal test to debug contagion system
 */

import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectId, YJS_GLOBALS } from "../";

import { isProxyEntity, type ModelType, referenceSymbol } from "../proxy-runtime-types.js";
import { buildModelClass } from "../proxy-runtime.js"; // Extended Y.Doc type for testing

// Extended Y.Doc type for testing
type TestYDoc = Y.Doc & { rootProjectId: ProjectId };

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
  const projectId: ProjectId = "test-project" as ProjectId;

  beforeEach(() => {
    doc = new Y.Doc();
    doc.getMap(YJS_GLOBALS.metadataMap).set(YJS_GLOBALS.metadataMapFields.projectId, projectId)
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
    const siteRef = (ephemeralSite as any)[referenceSymbol](projectId, doc);
    const entityId = siteRef[0];

    console.log("2. Materialized site, entityId:", entityId);
    console.log("3. Site ref:", siteRef);

    // Step 3: Verify we can spawn it
    const spawnedSite = Site.spawn(entityId, projectId, doc);
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
