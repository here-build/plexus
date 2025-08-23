/**
 * Plexus Schema Generator
 *
 * Generates proxy-model schemas using buildModelClass factory approach
 * instead of traditional TypeScript class inheritance.
 *
 * This module exports the generator functions but requires the consuming
 * application to provide the schema parsing and meta runtime logic.
 */

import fs from "fs";
import prettier from "prettier";
import dedent from "dedent";

// Abstract interfaces that must be provided by the consuming application
export interface Type {
  type: string;
  params: (string | Type)[];
}

export interface Field {
  name: string;
  type: Type;
  annotations: string[];
}

export interface Class {
  name: string;
  base: string | null | undefined; // Match DappSnap's expected interface
  fields: Field[];
  concrete?: boolean;
}

export interface MetaRuntime {
  allFields(cls: Class): Field[];
  getStrictSubclasses(cls: Class): Class[];
  isAbstract(cls: Class): boolean;
}

// These functions must be provided by the consuming application
export type ParseFunction = (schema: string) => any;
export type TransformFunction = (parsed: any) => Class[];
export type MetaRuntimeConstructor = new (classes: Class[], version: number) => MetaRuntime;

/**
 * Maps model schema types to proxy-model schema field types
 * Respects @WeakRef annotations for ownership semantics
 */
export function mapTypeToProxySchema(type: Type, field: Field): string {
  const isWeakRef = field.annotations.includes("WeakRef");
  
  switch (type.type) {
    // Primitive types - always "val" regardless of @WeakRef
    case "String":
    case "Number":
    case "Bool":
      return "val";

    // Schema Set = small collections
    case "Set":
      return isWeakRef ? "list" : "child-list";

    // Schema List = array 
    case "List":
      return isWeakRef ? "list" : "child-list";

    // Schema Map = records with keys
    case "Map":
      return isWeakRef ? "record" : "child-record";

    // Union types (Or) - treat as values since they're usually string literals
    case "Or":
      return "val";

    // Optional types - unwrap and use the inner type
    case "Optional":
      if (type.params.length === 1) {
        const innerType = type.params[0];
        if (typeof innerType === "string") {
          return "val";
        } else if (innerType instanceof Object && "type" in innerType) {
          return mapTypeToProxySchema(innerType as Type, field);
        }
      }
      return "val"; // Default for unknown optionals

    // String literals - treat as values
    case "StringLiteral":
      return "val";

    // Everything else is treated as object reference
    // @WeakRef = weak reference, no @WeakRef = owned child
    default:
      return isWeakRef ? "val" : "child-val";
  }
}

/**
 * Generates TypeScript interface definition from model class
 */
function generateTypeInterface(cls: Class, meta: MetaRuntime): string {
  const fields = meta.allFields(cls);
  const interfaceFields = fields
    .map((field) => {
      const isTransient = field.annotations.includes("Transient");
      const isOptionalType = field.type.type === "Optional";
      const isOptionalAnnotation = field.annotations.includes("Optional");
      const isConst = field.annotations.includes("Const");

      // Check if field type is a union that contains null/undefined (indicating it was originally optional)
      const isUnionWithNull = field.type.type === "Or" && field.type.params.some(param =>
        (typeof param === "string" && (param === "null" || param === "undefined")) ||
        (typeof param === "object" && param !== null && "type" in param &&
         (param.type === "null" || param.type === "undefined"))
      );

      // Check if field type is a union type (which often indicates optional field in original TypeScript)
      const isUnionType = field.type.type === "Or";

      // Arrays and Maps are never optional, even if they're Transient or Optional
      const isArrayOrMap = field.type.type === "List" || field.type.type === "Set" || field.type.type === "Map";

      // Check if field should allow null values (but still be required)
      // Union types often represent optional fields from TypeScript (field?: A | B)
      const allowsNull = (isTransient || isOptionalType || isOptionalAnnotation || isUnionWithNull || isUnionType) && !isArrayOrMap;

      const baseType = generateFieldTypeScript(field.type, meta);
      const nullSuffix = allowsNull ? " | null" : "";
      // Mark collections and @Const fields as readonly
      const readonlyMarker = isConst || isArrayOrMap ? "readonly " : "";

      return `    ${readonlyMarker}${field.name}: ${baseType}${nullSuffix};`;
    })
    .join("\n");

  return `  {\n${interfaceFields}\n  }`;
}

/**
 * Helper function to generate TypeScript type for a class name
 */
function generateClassTypeScript(className: string, meta: MetaRuntime): string {
  // Now all classes (abstract and concrete) are types, no typeof needed
  return className;
}

/**
 * Generates TypeScript type from model Type
 */
function generateFieldTypeScript(type: Type, meta?: MetaRuntime): string {
  switch (type.type) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Bool":
      return "boolean";

    case "Set":
      if (type.params.length === 1) {
        const paramType = type.params[0];
        const valueTs =
          typeof paramType === "string"
            ? paramType === "String"
              ? "string"
              : paramType === "Number"
                ? "number"
                : paramType === "Bool"
                  ? "boolean"
                  : paramType === "Any"
                    ? "any"
                    : paramType
            : generateFieldTypeScript(paramType, meta);
        return `Array<${valueTs}>`;
      }
      return "Array<any>";

    // Schema List = array (e.g. [Variant] -> (typeof Variant)[])
    case "List":
      if (type.params.length === 1) {
        const paramType = type.params[0];
        if (typeof paramType === "string") {
          if (paramType === "String") return "string[]";
          if (paramType === "Number") return "number[]";
          if (paramType === "Bool") return "boolean[]";
          if (paramType === "Any") return "any[]";
          return `(${paramType})[]`;
        } else if (paramType && typeof paramType === "object" && "type" in paramType) {
          return `(${generateFieldTypeScript(paramType as Type, meta)})[]`;
        }
      }
      return "any[]";

    // Schema Map = explicit maps (e.g. Map[String, String] -> Record<string, string>)
    case "Map":
      if (type.params.length === 2) {
        const keyType = type.params[0];
        const valueType = type.params[1];
        const keyTs =
          typeof keyType === "string"
            ? keyType === "String"
              ? "string"
              : keyType
            : generateFieldTypeScript(keyType as Type, meta);
        const valueTs =
          typeof valueType === "string"
            ? valueType === "String"
              ? "string"
              : valueType === "Number"
                ? "number"
                : valueType === "Bool"
                  ? "boolean"
                  : valueType === "Any"
                    ? "any"
                    : valueType
            : generateFieldTypeScript(valueType as Type, meta);
        return `Record<${keyTs}, ${valueTs}>`;
      }
      return "Record<string, any>";

    // Union types (Or) - create proper union type
    case "Or":
      const unionTypes = type.params
        .filter((param) => {
          // Filter out null and undefined from unions - we'll add clean | null at interface level
          if (typeof param === "string") {
            return param !== "null" && param !== "undefined";
          }
          if (param && typeof param === "object" && "type" in param) {
            const paramType = param as Type;
            return paramType.type !== "null" && paramType.type !== "undefined";
          }
          return true;
        })
        .map((param) => {
          if (typeof param === "string") {
            return param === "String"
              ? "string"
              : param === "Number"
                ? "number"
                : param === "Bool"
                  ? "boolean"
                  : param === "Any"
                    ? "any"
                    : param;
          } else if (param && typeof param === "object" && "type" in param) {
            const paramType = param as Type;
            if (paramType.type === "StringLiteral" && paramType.params.length === 1) {
              // String literal type like 'plain' | 'page'
              return `"${paramType.params[0]}"`;
            }
            return generateFieldTypeScript(paramType, meta);
          }
          return "any";
        })
        .join(" | ");
      return unionTypes;

    // String literals - return the literal value
    case "StringLiteral":
      if (type.params.length === 1) {
        return `"${type.params[0]}"`;
      }
      return "string";

    // Optional types - unwrap and make optional
    case "Optional":
      if (type.params.length === 1) {
        const wrappedType = type.params[0];
        const baseType =
          typeof wrappedType === "string"
            ? wrappedType === "String"
              ? "string"
              : wrappedType === "Number"
                ? "number"
                : wrappedType === "Bool"
                  ? "boolean"
                  : wrappedType === "Any"
                    ? "any"
                    : wrappedType
            : generateFieldTypeScript(wrappedType as Type, meta);
        return baseType; // The optionality is handled in the interface generation
      }
      return "any";

    default:
      return type.type === "Any" ? "any" : type.type;
  }
}

/**
 * Generates schema object for buildModelClass
 */
const generateSchemaObject = (cls: Class, meta: MetaRuntime): string => dedent`
  {
    ${meta
      .allFields(cls)
      .map((field) => `  ${field.name}: "${mapTypeToProxySchema(field.type, field)}"`)
      .join(",\n")}
    }
`;

/**
 * Gets all concrete descendant classes (recursive)
 */
function getAllConcreteDescendants(cls: Class, meta: MetaRuntime): Class[] {
  const subclasses = meta.getStrictSubclasses(cls);
  const concreteDescendants: Class[] = [];

  for (const subCls of subclasses) {
    if (meta.isAbstract(subCls)) {
      // Recursively get concrete descendants of abstract subclass
      concreteDescendants.push(...getAllConcreteDescendants(subCls, meta));
    } else {
      // Direct concrete subclass
      concreteDescendants.push(subCls);
    }
  }

  return concreteDescendants;
}

/**
 * Generates guard functions for a class
 */
function generateGuards(cls: Class, meta: MetaRuntime): string {
  const className = cls.name;
  const isAbstract = meta.isAbstract(cls);
  const allDescendants = getAllConcreteDescendants(cls, meta);

  if (isAbstract) {
    // Abstract classes need different guard logic since there's no constructor
    const instanceChecks = allDescendants.map((subCls) => `isKnown${subCls.name}(x)`).join(" || ");

    return `
export function isKnown${className}(x: any): x is ${className} {
  return ${instanceChecks || "false"};
}

export function ensureKnown${className}<T>(x: T): any extends T ? ${className} : Extract<T, ${className}> {
  invariant(isKnown${className}(x), \`Expected ${className}, got \${typeof x}: \${x}\`);
  return x;
}
`;
  } else if (allDescendants.length > 0) {
    // Concrete class with subclasses - check instanceof this class OR any subclass
    const subclassChecks = allDescendants.map((subCls) => `x instanceof ${subCls.name}`).join(" || ");

    return `
export function isKnown${className}(x: any): x is ${className} {
  return x instanceof ${className} || ${subclassChecks};
}

export function ensureKnown${className}(x: any): ${className} {
  invariant(isKnown${className}(x), \`Expected ${className}, got \${typeof x}: \${x}\`);
  return x;
}
`;
  } else {
    // Concrete classes without subclasses can use simple instanceof
    return `
export function isKnown${className}(x: any): x is ${className} {
  return x instanceof ${className};
}

export function ensureKnown${className}(x: any): ${className} {
  invariant(isKnown${className}(x), \`Expected ${className}, got \${typeof x}: \${x}\`);
  return x;
}
`;
  }
}

/**
 * Main generator function for proxy-model schemas
 *
 * @param classes - Array of parsed class definitions
 * @param metaRuntime - Runtime meta information
 * @param outputPath - Path to write the generated file
 */
export async function generateProxyModelSchemas(classes: Class[], metaRuntime: MetaRuntime, outputPath: string) {
  const meta = metaRuntime;

  // Generate abstract class type definitions and concrete class implementations
  const modelClassParts = classes.map((cls) => {
    const typeInterface = generateTypeInterface(cls, meta);
    const guards = generateGuards(cls, meta);
    const isAbstract = meta.isAbstract(cls);

    if (isAbstract) {
      // Abstract classes - create discriminated union of all concrete descendants
      const concreteDescendants = getAllConcreteDescendants(cls, meta);

      if (concreteDescendants.length > 0) {
        const unionTypes = concreteDescendants.map((subCls) => subCls.name).join(" | ");
        return `
// Abstract class: ${cls.name}
export type ${cls.name} = ${unionTypes};
export type I${cls.name} = ${cls.name};

${guards}
`;
      } else {
        // No concrete descendants found - fall back to ModelType
        return `
// Abstract class: ${cls.name}
export type ${cls.name}Params = ${typeInterface};
export type ${cls.name} = ModelType<${cls.name}Params, "${cls.name}">;
export type I${cls.name} = ${cls.name};

${guards}
`;
      }
    } else {
      // Concrete classes - check if they have subclasses
      const directSubclasses = meta.getStrictSubclasses(cls);
      const allDescendants = getAllConcreteDescendants(cls, meta);
      const schemaObject = generateSchemaObject(cls, meta);

      if (allDescendants.length > 0) {
        // Concrete class with subclasses - create union type
        const baseTypeName = `ModelType<${cls.name}Params, "${cls.name}">`;
        const unionTypes = [baseTypeName, ...allDescendants.map(subCls => subCls.name)].join(" | ");

        return `
// ${cls.name} model class (with subclasses)
export type ${cls.name}Params = ${typeInterface};
export type ${cls.name} = ${unionTypes};
export type I${cls.name} = ${cls.name};
export const ${cls.name} = buildModelClass<${baseTypeName}>("${cls.name}", ${schemaObject});

${guards}
`;
      } else {
        // Concrete class without subclasses - simple ModelType
        return `
// ${cls.name} model class
export type ${cls.name}Params = ${typeInterface};
export type ${cls.name} = ModelType<${cls.name}Params, "${cls.name}">;
export type I${cls.name} = ${cls.name};
export const ${cls.name} = buildModelClass<${cls.name}>("${cls.name}", ${schemaObject});

${guards}
`;
      }
    }
  });

  // Generate the complete file
  const fileContent = `
/* eslint-disable @typescript-eslint/no-empty-object-type,no-restricted-syntax,@typescript-eslint/no-unused-vars */
/**
 * Auto-generated proxy-model schemas
 * 
 * Generated using @dappsnap/plexus
 * Do not edit this file directly.
 */

import invariant from "tiny-invariant";

import { buildModelClass } from "@dappsnap/plexus";
import { type ModelType } from "@dappsnap/plexus";

${modelClassParts.join("\n")}

export const allModelClasses = {
${classes
  .filter((cls) => !meta.isAbstract(cls))
  .map((cls) => `  ${cls.name}`)
  .join(",\n")}
} as const;

export const justClasses = {
${classes
  .filter((cls) => !meta.isAbstract(cls))
  .map((cls) => `  ${cls.name}`)
  .join(",\n")}
} as const;

export type ObjInst = 
${classes
  .filter((cls) => !meta.isAbstract(cls))
  .map((cls) => `| ${cls.name}`)
  .join("\n")};
`;

  // Write the formatted file
  fs.writeFileSync(outputPath, await prettier.format(fileContent, { parser: "typescript" }));
}

/**
 * Convenience function that wraps the generator with parsing logic
 * This is the function that consuming applications should typically use
 */
export async function writeProxyModelSchemas(
  schema: string,
  outputPath: string,
  parse: ParseFunction,
  transform: TransformFunction,
  MetaRuntimeConstructor: MetaRuntimeConstructor
) {
  const classes = transform(parse(schema));
  const meta = new MetaRuntimeConstructor(classes, 0);
  await generateProxyModelSchemas(classes, meta, outputPath);
}
