import { describe, expect, it } from "vitest";
import type { Field } from "../generator";
import { mapTypeToProxySchema } from "../generator";

describe("@WeakRef annotation respect in codegen", () => {
  it("should generate child-* schema types for owned fields", () => {
    const valField: Field = {
      name: "ownedRef",
      type: { type: "Component", params: [] },
      annotations: [] // No @WeakRef
    };

    const listField: Field = {
      name: "ownedList",
      type: { type: "List", params: ["Component"] },
      annotations: [] // No @WeakRef
    };

    const setField: Field = {
      name: "ownedSet",
      type: { type: "Set", params: ["Component"] },
      annotations: [] // No @WeakRef
    };

    const recordField: Field = {
      name: "ownedRecord",
      type: { type: "Map", params: ["String", "Component"] },
      annotations: [] // No @WeakRef
    };

    expect(mapTypeToProxySchema(valField.type, valField)).toBe("child-val");
    expect(mapTypeToProxySchema(listField.type, listField)).toBe("child-list");
    expect(mapTypeToProxySchema(setField.type, setField)).toBe("child-list");
    expect(mapTypeToProxySchema(recordField.type, recordField)).toBe("child-record");
  });

  it("should generate base schema types for @WeakRef fields", () => {
    const valField: Field = {
      name: "weakRef",
      type: { type: "Component", params: [] },
      annotations: ["WeakRef"] // Has @WeakRef
    };

    const listField: Field = {
      name: "weakList",
      type: { type: "List", params: ["Component"] },
      annotations: ["WeakRef"] // Has @WeakRef
    };

    const setField: Field = {
      name: "weakSet",
      type: { type: "Set", params: ["Component"] },
      annotations: ["WeakRef"] // Has @WeakRef
    };

    const recordField: Field = {
      name: "weakRecord",
      type: { type: "Map", params: ["String", "Component"] },
      annotations: ["WeakRef"] // Has @WeakRef
    };

    expect(mapTypeToProxySchema(valField.type, valField)).toBe("val");
    expect(mapTypeToProxySchema(listField.type, listField)).toBe("list");
    expect(mapTypeToProxySchema(setField.type, setField)).toBe("list");
    expect(mapTypeToProxySchema(recordField.type, recordField)).toBe("record");
  });

  it("should always use 'val' for primitives regardless of @WeakRef", () => {
    const stringField: Field = {
      name: "text",
      type: { type: "String", params: [] },
      annotations: ["WeakRef"]
    };

    const numberField: Field = {
      name: "count",
      type: { type: "Number", params: [] },
      annotations: [] // No @WeakRef
    };

    expect(mapTypeToProxySchema(stringField.type, stringField)).toBe("val");
    expect(mapTypeToProxySchema(numberField.type, numberField)).toBe("val");
  });
});
