/* eslint-disable no-console,@typescript-eslint/no-empty-object-type */
/**
 * Contagious Proxy Runtime - Universal CRDT for Typed Object Models
 *
 * This system creates objects that exist in quantum superposition:
 * - EPHEMERAL: Local objects with full functionality, not synced
 * - MATERIALIZED: Same objects, now synced to YJS and shared across clients
 *
 * The "contagion" happens when ephemeral objects touch the YJS graph:
 * They automatically materialize (get entityId + sync) while preserving object identity.
 *
 * Key innovation: Same object reference throughout ephemeral → materialized transition.
 * No "upgrade" or replacement - the proxy behavior just changes internally.
 */

import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { ReadonlyDeep } from "type-fest";
import * as Y from "yjs";
import {
  type AllowedYJSValue,
  type AllowedYValue,
  isProxyEntity,
  type ModelPattern,
  type ModelType,
  type ModelTypeConstructor,
  type RecordSchema,
  type RecordSchemaInput,
  referenceDisclosureSymbol,
  referenceSymbol,
  type ReferenceTuple,
  type Storageable,
  type StrictRecordSchema
} from "./proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "./tracking.js"; // For packages that use plexus, ProjectId should be string

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

const isModelType = (object: any): object is ModelType<{}> => object?.[isProxyEntity] as boolean;

function maybeClone<T>(object: T): T {
  if (isModelType(object)) {
    return object.clone();
  } else {
    return object;
  }
}

// For packages that use plexus, ProjectId should be string
// This can be overridden by the consuming application
export type ProjectId = string;

// Simple default implementations for missing dependencies
class DefaultedMap<K, V> extends Map<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

class DefaultedWeakMap<K extends object, V> extends WeakMap<K, V> {
  constructor(private factory: () => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory());
    }
    return super.get(key)!;
  }
}

function never(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// PROJECT DEPENDENCY ARCHITECTURE:
// - ONE root project (editable, can create/modify entities)
// - MANY dependency projects (readonly, can only read entities)
// - Entities can reference across projects via cross-ref
// - Only root project entities can be mutated
type ExtendedYDoc = Y.Doc & {
  rootProjectId: ProjectId; // The single editable project in this document
};

// Entity cache
const documentEntityCaches = new DefaultedWeakMap<ExtendedYDoc, Map<string, WeakRef<ModelPattern>>>(
  () => new Map<string, WeakRef<ModelPattern>>()
);
const entityClasses = new Map<string, ModelTypeConstructor<{}, string>>();

const mutableArrayMethods = new Set<symbol | string>(["fill", "pop", "push", "reverse", "shift", "sort", "splice"]);
const mutableArrayMethodsPreservingLength = new Set<symbol | string>(["fill", "reverse", "sort"]);

type ExtractRecordSchema<T extends RecordSchemaInput | ModelPattern> =
  T extends ModelType<infer S extends RecordSchemaInput> ? S : T;
type ExtractClassName<T extends RecordSchemaInput | ModelPattern> = T extends ModelType<{}, infer N> ? N : string;

// Model class factory
export function buildModelClass<T extends RecordSchemaInput | ModelPattern>(
  typeName: string,
  schema: RecordSchema<T>
): ModelTypeConstructor<ExtractRecordSchema<T>, ExtractClassName<T>> {
  const clone = (target: ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>) => {
    const isTopLevel = cloneTransactionMapping === null;
    cloneTransactionMapping ??= new WeakMap();
    if (cloneTransactionMapping.has(target)) {
      return cloneTransactionMapping.get(target);
    }
    try {
      const clonedModel = new ModelConstructor(
        Object.fromEntries(
          Object.entries(schema).map(([fieldKey, type]) => {
            const fieldValue = target[fieldKey as keyof typeof target];

            if (type === "val") {
              // Primitive value or reference - copy directly
              return [fieldKey, fieldValue as AllowedYJSValue];
            } else if (type === "child-val") {
              // Child value - deep clone if it has .clone(), otherwise copy as-is
              return [fieldKey, null];
            } else if (type === "list") {
              // Regular list - shallow clone collection
              return [fieldKey, [...(fieldValue as any[])]];
            } else if (type === "child-list") {
              return [fieldKey, []];
            } else if (type === "set") {
              return [fieldKey, new Set(fieldValue as Set<any>)];
            } else if (type === "child-set") {
              return [fieldKey, new Set()];
            } else if (type === "record") {
              return [fieldKey, { ...fieldValue }];
            } else if (type === "child-record") {
              return [fieldKey, {}];
            } else {
              return [fieldKey, fieldValue];
            }
          })
        )
      );
      cloneTransactionMapping.set(target, clonedModel);
      for (const [fieldKey, type] of Object.entries(schema)) {
        const fieldValue = target[fieldKey as keyof typeof target];

        if (type === "child-val") {
          clonedModel[fieldKey] = maybeClone(fieldValue);
        } else if (type === "child-list") {
          clonedModel[fieldKey].assign((fieldValue as any[]).map(maybeClone));
        } else if (type === "child-set") {
          clonedModel[fieldKey].assign(new Set([...(fieldValue as Set<any>)].map(maybeClone)));
        } else if (type === "child-record") {
          clonedModel[fieldKey].assign(Object.fromEntries(Object.entries(fieldValue as Record<string, any>).map(([key, item]) => [key, maybeClone(item)])));
        }
      }
      return clonedModel;
    } finally {
      if (isTopLevel) {
        cloneTransactionMapping = null;
      }
    }
  };

  const spawn = (
    entityId: string,
    projectId: ProjectId,
    doc: ExtendedYDoc,
    internal__ephemeralExternalObject?: ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>
  ) => {
    const boundMaybeReference = curryMaybeReference(projectId, doc);
    const localReference = [entityId];
    const globalReference = [entityId, projectId];
    const cacheKey = `${projectId}.${entityId}`;
    const cached = documentEntityCaches.get(doc).get(cacheKey)?.deref();
    if (cached) {
      return cached as ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>;
    }
    const yprojectObjectInstanceFields = doc.getMap<Storageable>(`project:${projectId}:models`);
    const yprojectEntityType = doc.getMap<string>(`project:${projectId}:models:types`);
    const type = yprojectEntityType.get(entityId);
    invariant(type === typeName, `spawn type mismatch, ${type} !== ${typeName}`);

    // Dereference both tuple and legacy object references
    // eslint-disable-next-line sonarjs/function-return-type
    const deref = (pointer: AllowedYValue): AllowedYJSValue => {
      if (pointer == null) {
        return null;
      }
      if (typeof pointer !== "object") {
        return pointer;
      }

      if (!isTupleReference(pointer)) {
        // Not a reference, return as-is
        return pointer;
      }
      // New tuple format: [entityId] or [entityId, projectId]
      const targetEntityId = pointer[0];
      const targetProjectId = pointer[1] || projectId; // Default to current project

      const targetYProjectEntityType = doc.getMap<string>(`project:${targetProjectId}:models:types`);
      const targetType = targetYProjectEntityType.get(targetEntityId);
      invariant(targetType, `missing type for ${targetProjectId}.${targetEntityId}`);

      const constructor = entityClasses.get(targetType);
      invariant(constructor, `missing constructor ${targetType} for ${targetProjectId}.${targetEntityId}`);

      return constructor.spawn(targetEntityId, targetProjectId, doc);
    };

    // COLLECTION PROXY FACTORY & CACHE
    //
    // Each collection field (maps/arrays) gets its own proxy that:
    // 1. Wraps YJS Map/Array with native JavaScript interface
    // 2. Translates operations: obj[key]=val → yMap.set(key,val), arr.push() → yArray.push()
    // 3. Maintains object identity: repeated access to entity.children returns SAME proxy
    //
    // Schema → Proxy type mapping:
    // - "val-map"  → Proxy wrapping Y.Map<primitive>    (Object interface)
    // - "ref-map"  → Proxy wrapping Y.Map<Reference>    (Object interface)
    // - "val-list" → Proxy wrapping Y.Array<primitive>  (Array interface)
    // - "ref-list" → Proxy wrapping Y.Array<Reference>  (Array interface)
    const subproxyCache = new DefaultedMap<
      string,
      Record<string, AllowedYJSValue> | Array<AllowedYJSValue> | Set<AllowedYJSValue>
      // eslint-disable-next-line sonarjs/function-return-type
    >((key) => {
      const keyType = schema[key] as "record" | "list" | "set";

      // PROXY FACTORY: Create JavaScript interface wrapper for YJS collection
      switch (keyType) {
        case "list": {
          // REFERENCE LIST: Array of entity pointers
          // Get or create YJS Array for this field
          let list = yprojectObjectInstanceFields.get(`${entityId}.${key}`) as Y.Array<AllowedYValue> | undefined;
          if (!list) {
            list = new Y.Array();
            yprojectObjectInstanceFields.set(`${entityId}.${key}`, list);
          }

          // ARRAY PROXY: Presents JavaScript Array interface over YJS Array
          // Usage: entity.children.push(childEntity) → yArray.push(childEntity.reference())
          const arrayProxy = new Proxy([] as Array<ModelPattern | null>, {
            // eslint-disable-next-line sonarjs/cognitive-complexity
            get(target, elementKey) {
              // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
              switch (elementKey) {
                case "push":
                  // arr.push(entity) → yArray.push(entity.reference())
                  // eslint-disable-next-line sonarjs/no-nested-functions
                  return (...elements: Array<ModelPattern | null>) => {
                    trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
                    list.push(elements.map((element) => maybeReference(element, projectId, doc)));
                    return list.length;
                  };
                case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
                  // eslint-disable-next-line sonarjs/no-nested-functions
                  return (...elements: Array<ModelPattern | null>) => {
                    trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
                    list.unshift(elements.map((element) => maybeReference(element, projectId, doc)));
                    return list.length;
                  };
                case "clear": // arr.assign(newElements) → replace entire array contents
                  // eslint-disable-next-line sonarjs/no-nested-functions
                  return () => {
                    trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
                    trackModification(arrayProxy, ACCESS_INDICES_SET_SYMBOL);
                    // Clear existing contents
                    list.delete(0, list.length);
                  };
                case "assign": // arr.assign(newElements) → replace entire array contents
                  // eslint-disable-next-line sonarjs/no-nested-functions
                  return (newElements: Array<ModelPattern | null>) => {
                    trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
                    trackModification(arrayProxy, ACCESS_INDICES_SET_SYMBOL);
                    // Clear existing contents
                    list.delete(0, list.length);
                    // Add new elements
                    list.push(newElements.map((element) => maybeReference(element, projectId, doc)));
                  };
                case "length": // Report length access to this array
                  trackAccess(arrayProxy, ACCESS_INDICES_SET_SYMBOL);

                  return list.length;
              }
              // eslint-disable-next-line sonarjs/no-in-misuse
              if (elementKey in Array.prototype) {
                if (typeof Array.prototype[elementKey] === "function") {
                  return mutableArrayMethods.has(elementKey)
                    ? // eslint-disable-next-line sonarjs/no-nested-functions
                      (...args) => {
                        trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
                        if (!mutableArrayMethodsPreservingLength.has(elementKey)) {
                          trackModification(arrayProxy, ACCESS_INDICES_SET_SYMBOL);
                        }
                        const array = list.toArray().map(deref);
                        const result = array[elementKey](...args);

                        doc.transact(() => {
                          // todo optimized update strategy
                          list.delete(0, list.length);
                          list.push(array.map((element) => maybeReference(element, projectId, doc)));
                        });
                        return result;
                      }
                    : // eslint-disable-next-line sonarjs/no-nested-functions
                      (...args) => {
                        // Non-mutating array methods that iterate over all elements
                        trackAccess(arrayProxy, ACCESS_ALL_SYMBOL);
                        return list
                          .toArray()
                          .map(deref)
                          [elementKey](...args);
                      };
                } else {
                  // Report keyset access to this array for Array.prototype property access
                  trackAccess(arrayProxy, elementKey);
                  return Array.prototype[elementKey];
                }
              }
              // ARRAY ELEMENT ACCESS: arr[0] → deref(yArray.get(0))
              // Converts YJS References back to live entity objects
              if (typeof elementKey === "string") {
                const parsedElementKey = Number.parseInt(elementKey);
                if (Number.isSafeInteger(parsedElementKey)) {
                  // Report specific index access
                  trackAccess(arrayProxy, elementKey);
                  return deref(list.get(parsedElementKey)); // Reference → live entity
                }
              }
            },
            // eslint-disable-next-line sonarjs/cognitive-complexity
            set(target, elementKey, value) {
              trackModification(arrayProxy, elementKey);
              if (projectId !== doc.rootProjectId) {
                console.warn(
                  `cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`
                );
                return false;
              }
              if (elementKey === "length") {
                // Handle array length truncation
                const newLength = Number(value);
                if (Number.isSafeInteger(newLength) && newLength >= 0) {
                  if (newLength < list.length) {
                    // eslint-disable-next-line sonarjs/no-nested-functions
                    doc.transact(() => {
                      list.delete(newLength, list.length - newLength);
                    });
                  }
                  return true;
                }
                return false;
              }
              if (typeof elementKey === "string") {
                const parsedElementKey = Number.parseInt(elementKey);
                if (Number.isSafeInteger(parsedElementKey)) {
                  if (parsedElementKey < 0) {
                    console.warn(`cannot set ${type}[${parsedElementKey}] as it's below zero`);
                    return false;
                  } else if (parsedElementKey > list.length) {
                    // eslint-disable-next-line sonarjs/no-nested-functions
                    const postfix: null[] = [];
                    while (postfix.length + list.length < parsedElementKey - 1) {
                      postfix.push(null);
                    }
                    list.push([...postfix, boundMaybeReference(value)]);
                  } else {
                    // eslint-disable-next-line sonarjs/no-nested-functions
                    doc.transact(() => {
                      list.delete(parsedElementKey, 1);
                      list.insert(parsedElementKey, [boundMaybeReference(value)]);
                    });
                  }
                  return true;
                }
              }
              console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's non-declared`);
              return false;
            },
            deleteProperty() {
              return false;
            },
            // todo getOwnPropertyDescriptor
            setPrototypeOf() {
              return false;
            },
            has(target, elementKey) {
              if (elementKey === "length") {
                return true;
              }
              if (typeof elementKey === "string") {
                const parsedElementKey = Number.parseInt(elementKey);
                if (Number.isSafeInteger(parsedElementKey)) {
                  return parsedElementKey >= 0 && parsedElementKey < list.length;
                }
              }
              // eslint-disable-next-line sonarjs/no-in-misuse
              return elementKey in Array.prototype;
            },
            ownKeys() {
              trackAccess(arrayProxy, ACCESS_ALL_SYMBOL);
              return Reflect.ownKeys(list.toArray());
            },
            getPrototypeOf() {
              return Array.prototype;
            },
            isExtensible(): boolean {
              return true;
            }
          });
          return arrayProxy;
        }
        case "record": {
          let map = yprojectObjectInstanceFields.get(`${entityId}.${key}`) as Y.Map<AllowedYValue> | undefined;
          if (!map) {
            map = new Y.Map();
            yprojectObjectInstanceFields.set(`${entityId}.${key}`, map);
          }
          const mapProxy = new Proxy({} as Record<string, ModelPattern>, {
            get(target, elementKey) {
              switch (elementKey) {
                case "clear":
                  return () => {
                    trackModification(mapProxy, ACCESS_ALL_SYMBOL);
                    trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
                    map.clear();
                  };
                case "assign":
                  return (newEntries: Record<string, ModelPattern> | Iterable<[string, ModelPattern]>) => {
                    trackModification(mapProxy, ACCESS_ALL_SYMBOL);
                    trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
                    // Clear existing contents
                    map.clear();
                    // Add new entries
                    if (Symbol.iterator in Object(newEntries)) {
                      // Iterable of [key, value] pairs
                      for (const [k, v] of newEntries as Iterable<[string, ModelPattern]>) {
                        map.set(k, maybeReference(v, projectId, doc));
                      }
                    } else {
                      // Record object
                      for (const [k, v] of Object.entries(newEntries as Record<string, ModelPattern>)) {
                        map.set(k, maybeReference(v, projectId, doc));
                      }
                    }
                  };
              }
              if (elementKey in Object.prototype) {
                // Accessing Object prototype methods. Todo make more precise
                trackAccess(mapProxy, ACCESS_ALL_SYMBOL);
                return Object.prototype[elementKey];
              } else if (typeof elementKey === "string") {
                // Specific field access
                trackAccess(mapProxy, elementKey);
                return deref(map.get(elementKey) ?? null);
              }
            },
            set(target, elementKey, value) {
              if (projectId !== doc.rootProjectId) {
                console.warn(
                  `cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`
                );
                return false;
              }
              if (typeof elementKey === "string") {
                trackModification(mapProxy, elementKey);
                if (value != null) {
                  map.set(elementKey, maybeReference(value, projectId, doc));
                  return true;
                } else {
                  trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
                  map.delete(elementKey);
                  return true;
                }
              }
              console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's non-declared`);
              return false;
            },
            deleteProperty(target, elementKey) {
              // noinspection SuspiciousTypeOfGuard
              if (typeof elementKey === "symbol") {
                return false;
              }
              if (map.has(elementKey)) {
                if (projectId !== doc.rootProjectId) {
                  console.warn(`cannot delete property ${elementKey} of ${type} as it's readonly dependency reference`);
                  return false;
                }
                trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
                map.delete(elementKey);
                return true;
              }
              console.warn(`cannot delete property ${elementKey} of ${type} as it's non-declared`);
              return false;
            },
            // todo getOwnPropertyDescriptor
            setPrototypeOf() {
              return false;
            },
            has(target, elementKey) {
              if (typeof elementKey === "string") {
                trackAccess(mapProxy, elementKey);
                return map.has(elementKey);
              }
              return false;
            },
            ownKeys() {
              trackAccess(mapProxy, ACCESS_INDICES_SET_SYMBOL);
              return [...map.keys()];
            },
            getPrototypeOf() {
              return Object.prototype;
            },
            isExtensible(): boolean {
              return true;
            }
          });
          return mapProxy;
        }
        case "set": {
          // Sets are small collections (params, states) backed by YJS Array
          // Present Record<string, T> interface but use array storage + includes()
          let underlyingArray = yprojectObjectInstanceFields.get(`${entityId}.${key}`) as
            | Y.Array<AllowedYValue>
            | undefined;
          if (!underlyingArray) {
            underlyingArray = new Y.Array();
            yprojectObjectInstanceFields.set(`${entityId}.${key}`, underlyingArray);
          }

          const setProxyInit: ProxyHandler<Y.Array<AllowedYValue>> = {
            get(target, elementKey) {
              switch (elementKey) {
                case "size":
                  return target.length;
                case "add":
                  return (value: AllowedYJSValue) => {
                    // here and below we're using deref and not boundRef to ensure that entities are unique,
                    // allowing us to directly compare instead of structural checks
                    if (!target.toArray().map(deref).includes(value)) {
                      trackModification(setProxy, ACCESS_ALL_SYMBOL);
                      target.push([boundMaybeReference(value)]);
                      return true;
                    }
                    return false;
                  };
                case "clear":
                  return () => {
                    const outputLength = target.length;
                    if (outputLength === 0) {
                      return 0;
                    }
                    trackModification(setProxy, ACCESS_ALL_SYMBOL);
                    target?.delete(0, outputLength);
                    return outputLength;
                  };
                case "assign":
                  return (newValues: Iterable<AllowedYJSValue>) => {
                    trackModification(setProxy, ACCESS_ALL_SYMBOL);
                    // Clear existing contents
                    target?.delete(0, target.length);
                    // Add new values
                    for (const value of newValues) {
                      if (!target.toArray().map(deref).includes(value)) {
                        target.push([boundMaybeReference(value)]);
                      }
                    }
                  };
                case "delete":
                  return (value: AllowedYJSValue) => {
                    const index = target.toArray().map(deref).indexOf(value);
                    if (index === -1) {
                      return false;
                    }
                    target.delete(index, 1);
                    trackModification(setProxy, ACCESS_ALL_SYMBOL);
                    return true;
                  };
                case "entries":
                  return () => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return target
                      .toArray()
                      .map(deref)
                      .map((v) => [v, v]);
                  };
                case "values":
                case "keys":
                  return () => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return target.toArray().map(deref);
                  };
                // todo Symbol.iterator
                case "forEach":
                  return (
                    callbackfn: (value: AllowedYJSValue, value2: AllowedYJSValue, set: Set<AllowedYJSValue>) => void,
                    thisArg?: any
                  ) => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return new Set(target.toArray().map(deref)).forEach(callbackfn, thisArg);
                  };
                case "has":
                  return (value: AllowedYJSValue) => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return target.toArray().map(deref).includes(value);
                  };
                case "intersection":
                  throw new Error("not implemented yet");
                case "isDisjointFrom":
                  return (set: Set<AllowedYJSValue>) => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return new Set(target.toArray().map(deref)).isDisjointFrom(set);
                  };
                case "isSubsetOf":
                  return (set: Set<AllowedYJSValue>) => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return new Set(target.toArray().map(deref)).isSubsetOf(set);
                  };
                case "isSupersetOf":
                  return (set: Set<AllowedYJSValue>) => {
                    trackAccess(setProxy, ACCESS_ALL_SYMBOL);
                    return new Set(target.toArray().map(deref)).isSupersetOf(set);
                  };
                default:
                  return false;
              }
            },
            set() {
              throw new Error("cannot set properties to syncing Set");
            },
            deleteProperty() {
              throw new Error("cannot set properties to syncing Set");
            },
            has() {
              return false;
            },
            ownKeys() {
              return [];
            },
            getPrototypeOf() {
              return Set.prototype;
            },
            isExtensible(): boolean {
              return false;
            }
          };

          const setProxy = new Proxy(underlyingArray, setProxyInit);
          return setProxy as any as Set<AllowedYJSValue>;
        }
        default:
          never(keyType);
      }
    });

    const proxy = new Proxy(
      {},
      {
        get(target, key) {
          if (key === isProxyEntity) return true;
          if (key === referenceDisclosureSymbol) {
            return {
              projectId,
              doc
            };
          }
          if (key === "uuid") {
            // Expose entity ID as uuid field for DappSnap compatibility
            // Non-enumerable to maintain clean iteration behavior
            return entityId;
          }
          if (key === referenceSymbol) {
            // REFERENCE TYPE SELECTION.
            // This allows entities to reference dependencies while maintaining project boundaries
            return (assertedProjectId: string, assertedDoc: ExtendedYDoc) => {
              invariant(
                doc === assertedDoc,
                `document misalignment: expected project<${doc.rootProjectId}> doc, got project<${assertedDoc.rootProjectId}> doc`
              );
              // we're explicitly using pre-materialized references so we will be able to directly compare them
              return projectId === assertedProjectId
                ? localReference // Local reference tuple: [entityId]
                : globalReference; // Cross-project reference tuple: [entityId, projectId]
            };
          }
          if (key === "clone") {
            // TRANSACTIONAL CLONE: Creates a new entity using constructor pattern
            // Handles cycles and deduplication via clone transaction mapping
            return () => clone(proxy);
          }
          if (typeof key === "string" && Object.hasOwn(schema, key)) {
            // Specific field access on the main entity
            trackAccess(trackingPointer, key);

            if (subproxyCache.has(key)) {
              return subproxyCache.get(key);
            }
            return schema[key] === "val"
              ? deref(yprojectObjectInstanceFields.get(`${entityId}.${key}`) as AllowedYValue)
              : subproxyCache.get(key);
          }
          return Object.prototype[key];
        },
        set(target, elementKey, value) {
          // READONLY DEPENDENCY ENFORCEMENT:
          // Only entities from the root project can be modified
          // Dependency entities are immutable from this document's perspective
          if (projectId !== doc.rootProjectId) {
            console.warn(
              `cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`
            );
            return false; // Silently reject writes to readonly dependencies
          }
          if (typeof elementKey === "string") {
            const keyType = schema[elementKey];
            if (keyType === "val") {
              trackModification(trackingPointer, elementKey);
              yprojectObjectInstanceFields.set(`${entityId}.${elementKey}`, maybeReference(value, projectId, doc));
              return true;
            }
            invariant(!keyType, "cannot directly set complex type");
          }
          console.warn(
            `cannot set property Symbol(${elementKey.toString()}) of ${type} as only string properties are supported`
          );
          return false;
        },
        // todo getOwnPropertyDescriptor
        setPrototypeOf() {
          return false;
        },
        has(target, key) {
          // "in" operator checks for field existence (materialized entity)
          if (Object.hasOwn(schema, key)) {
            trackAccess(trackingPointer, key);
            return true;
          }
          return key === referenceSymbol || key === "uuid";
        },
        ownKeys() {
          // ownKeys accesses all entity field names (materialized entity)
          // uuid is not included to keep it non-enumerable
          trackAccess(trackingPointer, ACCESS_INDICES_SET_SYMBOL);
          return Object.keys(schema);
        },
        getPrototypeOf() {
          return ModelConstructor;
        },
        isExtensible(): boolean {
          return false;
        }
      }
    ) as ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>;
    const trackingPointer = internal__ephemeralExternalObject ?? proxy;
    if (!internal__ephemeralExternalObject) {
      documentEntityCaches.get(doc).set(cacheKey, new WeakRef(proxy as ModelPattern));
    }
    return proxy;
  };

  const ModelConstructor = Object.defineProperties(
    function ModelConstructor(this: any, initialState: ReadonlyDeep<StrictRecordSchema<T>>) {
      let manifestedState: ModelType<ExtractRecordSchema<T>, ExtractClassName<T>> | null = null;
      const entityId = nanoid();
      const localReference: ReferenceTuple = [entityId];
      let globalReference: ReferenceTuple | null = null; // we will materialize it later

      const ephemeralModel = new Proxy(initialState as ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>, {
        // QUANTUM SUPERPOSITION HANDLER:
        // This proxy exists in two states simultaneously:
        // - BEFORE materialization: Acts on local `target` data
        // - AFTER materialization: Forwards everything to YJS-synced `manifestedState`
        // Same object reference, different behavior based on internal state.
        // eslint-disable-next-line sonarjs/function-return-type
        get(target, key) {
          if (key === isProxyEntity) return true;
          // POST-MATERIALIZATION: Forward all access to the YJS-synced version
          if (manifestedState) {
            return Reflect.get(manifestedState, key);
          }
          if (key === "uuid") {
            return entityId;
          }
          if (key === referenceSymbol) {
            return function reference(
              this: ModelType<ExtractRecordSchema<T>, ExtractClassName<T>>,
              projectId: ProjectId,
              doc: ExtendedYDoc
            ): ReferenceTuple {
              if (globalReference) {
                return projectId === globalReference[1] ? localReference : globalReference;
              }
              globalReference = [entityId, projectId];
              if (manifestedState) {
                return manifestedState[referenceSymbol](projectId, doc);
              }
              const boundMaybeReference = curryMaybeReference(projectId, doc);
              // eslint-disable-next-line sonarjs/no-nested-functions
              return doc.transact(() => {
                const yprojectObjectInstanceFields = doc.getMap<Storageable>(`project:${projectId}:models`);
                const yprojectEntityType = doc.getMap<string>(`project:${projectId}:models:types`);

                yprojectEntityType.set(entityId, typeName);
                for (const [schemaKey, type] of Object.entries(schema) as [
                  string,
                  "val" | "list" | "record" | "set"
                ][]) {
                  switch (type) {
                    case "val":
                      yprojectObjectInstanceFields.set(
                        `${entityId}.${schemaKey}`,
                        boundMaybeReference(target[schemaKey] as AllowedYJSValue)
                      );
                      break;
                    case "list":
                      yprojectObjectInstanceFields.set(
                        `${entityId}.${schemaKey}`,
                        // @ts-expect-error todo yjs Array.from not supporting boolean
                        Y.Array.from(
                          // @ts-expect-error todo yjs Array.from not supporting boolean
                          // Convert sparse arrays to dense arrays (holes become null)
                          Array.from<AllowedYJSValue, AllowedYValue>(target[schemaKey] ?? [], boundMaybeReference)
                        )
                      );
                      break;
                    case "record":
                      yprojectObjectInstanceFields.set(
                        `${entityId}.${schemaKey}`,
                        new Y.Map<AllowedYValue | null>(
                          Object.entries((target[schemaKey] as Record<string, AllowedYJSValue> | null) ?? {}).map(
                            ([recordKey, val]) => [recordKey, boundMaybeReference(val)]
                          )
                        )
                      );
                      break;
                    case "set":
                      yprojectObjectInstanceFields.set(
                        `${entityId}.${schemaKey}`,
                        // @ts-expect-error todo yjs Array.from not supporting boolean
                        Y.Array.from(
                          // @ts-expect-error todo yjs Array.from not supporting boolean
                          (target[schemaKey] as Set<AllowedYJSValue>).values().map(boundMaybeReference)
                        )
                      );
                      break;
                    default:
                      never(type);
                  }
                }

                // IDENTITY PRESERVATION MINDFUCK:
                //
                // This ephemeral proxy is about to become the canonical reference for this entity.
                // Here's what happens:
                //
                // 1. We create a YJS-backed proxy via spawn() (manifestedState)
                // 2. We cache THIS ephemeral proxy (not the materialized one) as canonical
                // 3. This proxy forwards all behavior to manifestedState via the get() handler above
                // 4. Future spawn() calls for this entityId return THIS SAME ephemeral proxy
                // 5. Result: Perfect object identity - ephemeral === materialized references
                //
                // The proxy becomes a pointer to its own materialized form while remaining itself.
                // Existential crisis: The object IS the reference TO itself.
                const cacheKey = `${projectId}.${entityId}`;
                const entityCache = documentEntityCaches.get(doc);
                if (!entityCache.has(cacheKey)) {
                  manifestedState ??= spawn(entityId, projectId, doc);
                  entityCache.set(cacheKey, new WeakRef(ephemeralModel)); // Cache SELF, not spawn result
                }
                return projectId === doc.rootProjectId ? localReference : globalReference!;
              });
            };
          }
          if (key === "clone") {
            // EPHEMERAL CLONE: Creates a new ephemeral entity with same structure and field values
            return () => clone(target);
          }
          if (key in Object.prototype) {
            return target[key as keyof typeof target];
          }
          if (Object.hasOwn(schema, key)) {
            const schemaType = schema[key];
            const fieldValue = target[key as keyof typeof target];

            // CONTAGION-AWARE COLLECTION PROXIES FOR EPHEMERAL STATE
            // Return proxies that can trigger contagion when items are added
            if (schemaType === "list") {
              const ephemeralListProxy = new Proxy(fieldValue as Array<ModelPattern | null>, {
                get(listTarget, listKey) {
                  if (listKey === "length") {
                    trackAccess(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                  } else if (typeof listKey === "string" && Number.isSafeInteger(Number.parseInt(listKey))) {
                    // Index access for ephemeral arrays
                    trackAccess(ephemeralListProxy, listKey);
                  } else if (listKey === "clear") {
                    // arr.assign(newElements) → replace entire array contents
                    return () => {
                      if (listTarget.length > 0) {
                        trackModification(ephemeralListProxy, ACCESS_ALL_SYMBOL);
                        trackModification(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                      }
                      // Clear existing contents
                      listTarget.length = 0;
                    };
                  } else if (listKey === "assign") {
                    // arr.assign(newElements) → replace entire array contents
                    return (newElements: Array<ModelPattern | null>) => {
                      trackModification(ephemeralListProxy, ACCESS_ALL_SYMBOL);
                      trackModification(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                      // Clear existing contents
                      listTarget.length = 0;
                      // Add new elements
                      listTarget.push(...newElements);

                      // Check for contagion
                      for (const item of listTarget) {
                        const disclosure = item?.[referenceDisclosureSymbol]?.();
                        if (disclosure) {
                          definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                        }
                      }
                    };
                  } else if (listKey in Array.prototype) {
                    if (mutableArrayMethods.has(listKey)) {
                      // eslint-disable-next-line sonarjs/no-nested-functions
                      return (...args) => {
                        const result = listTarget[listKey](...args);
                        for (const item of listTarget) {
                          const disclosure = item?.[referenceDisclosureSymbol]?.();
                          if (disclosure) {
                            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                          }
                        }
                        trackModification(ephemeralListProxy, ACCESS_ALL_SYMBOL);
                        if (!mutableArrayMethodsPreservingLength.has(key)) {
                          // sometimes it is a lie, but it's cheaper to do redundant update notification than incorporate all the logic inside setters
                          trackModification(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                        }
                        return result;
                      };
                    } else if (typeof Array.prototype[listKey] === "function") {
                      return (...args) => {
                        trackAccess(ephemeralListProxy, ACCESS_ALL_SYMBOL);
                        return listTarget[listKey](...args);
                      };
                    }
                  }

                  // Let everything else pass through to target
                  return Reflect.get(listTarget, listKey);
                },
                set(listTarget, listKey, value) {
                  const result = Reflect.set(listTarget, listKey, value);
                  // Trigger contagion if setting an entity
                  if (typeof listKey === "string" && Number.isSafeInteger(Number.parseInt(listKey))) {
                    const disclosure = (value as ModelPattern)?.[referenceDisclosureSymbol]?.();
                    if (disclosure) {
                      definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                    }
                    trackModification(ephemeralModel, key);
                    trackModification(ephemeralListProxy, listKey);
                  }
                  return result;
                },
                has(listTarget, listKey) {
                  // Array "in" operator for index checks
                  if (typeof listKey === "string" && Number.isSafeInteger(Number.parseInt(listKey))) {
                    trackAccess(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                  }
                  return Reflect.has(listTarget, listKey);
                },
                ownKeys(listTarget) {
                  // Object.keys() or array enumeration
                  trackAccess(ephemeralListProxy, ACCESS_INDICES_SET_SYMBOL);
                  return Reflect.ownKeys(listTarget);
                }
              });
              return ephemeralListProxy;
            }

            if (schemaType === "record") {
              const ephemeralMapProxy = new Proxy(fieldValue as Record<string, ModelPattern | null>, {
                get(mapTarget, mapKey) {
                  if (mapKey === "clear") {
                    return () => {
                      if (Object.keys(mapTarget).length > 0) {
                        trackModification(ephemeralMapProxy, ACCESS_ALL_SYMBOL);
                        trackModification(ephemeralMapProxy, ACCESS_INDICES_SET_SYMBOL);
                      }
                      for (const key of Object.keys(mapTarget)) {
                        delete mapTarget[key];
                      }
                    };
                  }
                  if (mapKey === "assign") {
                    return (newEntries: Record<string, ModelPattern> | Iterable<[string, ModelPattern]>) => {
                      trackModification(ephemeralMapProxy, ACCESS_ALL_SYMBOL);
                      trackModification(ephemeralMapProxy, ACCESS_INDICES_SET_SYMBOL);
                      // Clear existing contents
                      for (const key of Object.keys(mapTarget)) {
                        delete mapTarget[key];
                      }
                      // Add new entries
                      if (Symbol.iterator in Object(newEntries)) {
                        // Iterable of [key, value] pairs
                        for (const [k, v] of newEntries as Iterable<[string, ModelPattern]>) {
                          mapTarget[k] = v;
                          const disclosure = (v as ModelPattern)?.[referenceDisclosureSymbol]?.();
                          if (disclosure) {
                            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                          }
                        }
                      } else {
                        // Record object
                        for (const [k, v] of Object.entries(newEntries as Record<string, ModelPattern>)) {
                          mapTarget[k] = v;
                          const disclosure = (v as ModelPattern)?.[referenceDisclosureSymbol]?.();
                          if (disclosure) {
                            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                          }
                        }
                      }
                    };
                  }
                  // todo support well known symbols
                  if (mapKey in Object.prototype && typeof Object.prototype[mapKey] === "function") {
                    return (...args) => {
                      // Object prototype method access
                      trackAccess(ephemeralMapProxy, ACCESS_ALL_SYMBOL);
                      // @ts-expect-error todo
                      return mapTarget[mapKey](...args);
                    };
                  }
                  if (typeof mapKey === "string") {
                    // Specific key access in ephemeral map
                    trackAccess(ephemeralMapProxy, mapKey);
                  }
                  return Reflect.get(mapTarget, mapKey);
                },
                set(mapTarget, mapKey, value) {
                  trackModification(ephemeralMapProxy, mapKey);
                  // we actually should check if we created a new key but it's more expensive than marking keyset updated
                  trackModification(ephemeralMapProxy, ACCESS_INDICES_SET_SYMBOL);
                  const result = Reflect.set(mapTarget, mapKey, value);
                  // Trigger contagion when setting an entity
                  if (typeof mapKey === "string") {
                    const disclosure = (value as ModelPattern)?.[referenceDisclosureSymbol]?.();
                    if (disclosure) {
                      definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                    }
                  }
                  return result;
                },
                has(mapTarget, mapKey) {
                  // "in" operator checks for key existence
                  trackAccess(ephemeralMapProxy, mapKey);
                  return Reflect.has(mapTarget, mapKey);
                },
                ownKeys(mapTarget) {
                  // Object.keys() accesses all map keys
                  trackAccess(ephemeralMapProxy, ACCESS_INDICES_SET_SYMBOL);
                  return Reflect.ownKeys(mapTarget);
                }
              });
              return ephemeralMapProxy;
            }

            if (schemaType === "set") {
              const setProxyInit: ProxyHandler<Set<AllowedYJSValue>> = {
                get(target, elementKey) {
                  switch (elementKey) {
                    case "size":
                      return target.size;
                    case "add":
                      return (value: AllowedYJSValue) => {
                        if (target.add(value)) {
                          trackModification(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                          const disclosure = (value as ModelPattern)?.[referenceDisclosureSymbol]?.();
                          if (disclosure) {
                            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                          }
                          return true;
                        }
                        return false;
                      };
                    case "clear":
                      return () => {
                        if (target.size > 0) {
                          trackModification(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                          target.clear();
                        }
                      };
                    case "assign":
                      return (newValues: Iterable<AllowedYJSValue>) => {
                        trackModification(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        // Clear existing contents
                        target.clear();
                        // Add new values
                        for (const value of newValues) {
                          target.add(value);
                          const disclosure = (value as ModelPattern)?.[referenceDisclosureSymbol]?.();
                          if (disclosure) {
                            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
                          }
                        }
                      };
                    case "delete":
                      return (value: AllowedYJSValue) => {
                        if (target.has(value)) {
                          trackModification(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        }
                        return target.delete(value);
                      };
                    case "entries":
                      return () => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.entries();
                      };
                    case "keys":
                    case "values":
                      return () => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.values();
                      };
                    // todo Symbol.iterator
                    case "forEach":
                      return (
                        callbackfn: (
                          value: AllowedYJSValue,
                          value2: AllowedYJSValue,
                          set: Set<AllowedYJSValue>
                        ) => void,
                        thisArg?: any
                      ) => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.forEach(callbackfn, thisArg);
                      };
                    case "has":
                      return (value: AllowedYJSValue) => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.has(value);
                      };
                    case "intersection":
                      throw new Error("not implemented yet");
                    case "isDisjointFrom":
                      return (set: Set<AllowedYJSValue>) => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.isDisjointFrom(set);
                      };
                    case "isSubsetOf":
                      return (set: Set<AllowedYJSValue>) => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.isSubsetOf(set);
                      };
                    case "isSupersetOf":
                      return (set: Set<AllowedYJSValue>) => {
                        trackAccess(ephemeralSetProxy, ACCESS_ALL_SYMBOL);
                        return target.isSupersetOf(set);
                      };
                    default:
                      return false;
                  }
                },
                set() {
                  throw new Error("cannot set properties to syncing Set");
                },
                deleteProperty() {
                  throw new Error("cannot set properties to syncing Set");
                },
                has() {
                  return false;
                },
                ownKeys() {
                  return [];
                },
                getPrototypeOf() {
                  return Set.prototype;
                },
                isExtensible(): boolean {
                  return false;
                }
              };
              const ephemeralSetProxy = new Proxy(fieldValue as Set<AllowedYJSValue>, setProxyInit);
              return ephemeralSetProxy;
            }

            // Simple field access for "val" type
            trackAccess(ephemeralModel, key);
            return fieldValue;
          }
          return;
        },

        // eslint-disable-next-line sonarjs/cognitive-complexity
        set(target, elementKey, value) {
          if (manifestedState) {
            return Reflect.set(manifestedState, elementKey, value);
          }
          if (!Object.hasOwn(schema, elementKey)) {
            console.warn(
              `cannot set property ${elementKey.toString()} of ${typeName} as it is not declared in type schema`
            );
            return false;
          }
          invariant(
            schema[elementKey] === "val",
            `cannot directly assign ${schema[elementKey]}-typed ${typeName}.${elementKey.toString()}; instead manipulate the existing object`
          );
          const disclosure = (value as ModelPattern | null)?.[referenceDisclosureSymbol]?.();
          if (disclosure) {
            definitelyReference(ephemeralModel, disclosure.projectId, disclosure.doc);
            ephemeralModel[elementKey] = value;
          } else {
            target[elementKey] = value;
            // in other branch we are doing tracking with manifested state
            trackModification(ephemeralModel, elementKey);
          }
          return true;
        },

        deleteProperty(target, key) {
          if (manifestedState) {
            return Reflect.deleteProperty(manifestedState, key);
          }
          if (schema[key] === "val") {
            trackModification(ephemeralModel, key);
            trackModification(ephemeralModel, ACCESS_INDICES_SET_SYMBOL);

            delete target[key as keyof typeof target];
            return true;
          }
          return false;
        },
        // todo getOwnPropertyDescriptor
        setPrototypeOf() {
          return false;
        },
        has(target, key) {
          // "in" operator checks for field existence (ephemeral entity)
          if (Object.hasOwn(schema, key)) {
            trackAccess(ephemeralModel, key);
          }
          return key === referenceSymbol || key === "uuid" || Object.hasOwn(schema, key);
        },
        ownKeys() {
          // ownKeys accesses all entity field names (ephemeral entity)
          // Include _ephemeralUuid if it exists to satisfy proxy invariants
          trackAccess(ephemeralModel, ACCESS_INDICES_SET_SYMBOL);
          return Object.keys(schema);
        },
        getPrototypeOf() {
          return ModelConstructor;
        },
        isExtensible(): boolean {
          return false;
        }
      });
      return ephemeralModel;
    },
    {
      __type: { value: typeName },
      schema: { value: schema },
      spawn: { value: spawn }
    }
  ) as any as ModelTypeConstructor<ExtractRecordSchema<T>, ExtractClassName<T>>;

  entityClasses.set(typeName, ModelConstructor as any);

  return ModelConstructor;
}

const isModel = (val: any): val is ModelPattern => val && typeof val === "object" && referenceSymbol in val;

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length >= 1 && val.length <= 2 && typeof val[0] === "string";

const definitelyReference = (val: ModelPattern, projectId: ProjectId, doc: Y.Doc): AllowedYValue =>
  val[referenceSymbol](projectId, doc);

const maybeReference = (val: AllowedYJSValue, projectId: ProjectId, doc: Y.Doc): AllowedYValue =>
  (isModel(val) ? val[referenceSymbol](projectId, doc) : val) ?? null;

const curryMaybeReference =
  (projectId: ProjectId, doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    (isModel(val) ? val[referenceSymbol](projectId, doc) : val) ?? null;
