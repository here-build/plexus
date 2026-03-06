import { test, expect } from "vitest";
import { Plexus, PlexusModel, syncing } from "../index.js";

@syncing("TestModel")
class TestModel extends PlexusModel {
    @syncing accessor title: string = "hello";
    @syncing.list accessor tags: string[] = ["a"];
}

test("snapshot test", () => {
    const p = new TestModel();

    console.log("JSON:", JSON.stringify(p));
    console.log("Spread:", { ...p });
    try {
        console.log("structuredClone:", structuredClone(p));
    } catch (e: any) {
        console.log("structuredClone Error:", e.message);
    }
});
