import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue } from "../proxy-runtime-types.js";
import { DefaultedMap } from "@here.build/collections";

/**
 * Validate that a value is an allowed type for map keys.
 * Throws TypeError for disallowed types.
 */
function validateKeyElement(item: unknown): void {
  const type = typeof item;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint" || item === null) {
    return; // Valid primitive
  }
  if (item instanceof PlexusModel) {
    return; // Valid model reference
  }
  if (type === "undefined") {
    throw new TypeError("undefined is not allowed as a map key element in Plexus");
  }
  if (type === "symbol") {
    throw new TypeError("Symbols are not allowed as map key elements in Plexus");
  }
  if (type === "function") {
    throw new TypeError("Functions are not allowed as map key elements in Plexus");
  }
  throw new TypeError(
    `Plain objects are not allowed as map key elements in Plexus. ` +
      `Use PlexusModel or primitives instead. Got: ${Object.prototype.toString.call(item)}`,
  );
}

/**
 * Trie node for efficient structural key lookup.
 * Uses WeakMap for PlexusModel keys (GC-friendly) and Map for primitives.
 *
 * canonicalKey can be:
 * - K (strong reference) when entry is active
 * - WeakRef<K & object> when entry is deleted but key might be used for comparison
 * - undefined when no key has ever been stored at this path
 */
type TrieNode<K, V> = {
  value: V | undefined;
  keyId: number | undefined;
  canonicalKey: K | WeakRef<K & object> | undefined;
  children: DefaultedMap<AllowedYJSValue, TrieNode<K, V>>;
};

const createNode = <K extends AllowedYJSMapKey, V>(): TrieNode<K, V> => ({
  value: undefined,
  keyId: undefined,
  canonicalKey: undefined,
  children: new DefaultedMap<AllowedYJSValue, TrieNode<K, V>>(createNode),
});

/**
 * Canonical sort for Set elements.
 * Models first (by uuid), then primitives (by type, then by value).
 */
export function canonicalSort(a: AllowedYJSValue, b: AllowedYJSValue): number {
  const aIsModel = a instanceof PlexusModel;
  const bIsModel = b instanceof PlexusModel;

  // Models come first
  if (aIsModel && !bIsModel) return -1;
  if (!aIsModel && bIsModel) return 1;

  // Both models: sort by uuid
  if (aIsModel && bIsModel) {
    return a.uuid.localeCompare(b.uuid);
  }

  // Both primitives: sort by type first, then by value
  const aType = a === null ? "null" : typeof a;
  const bType = b === null ? "null" : typeof b;
  if (aType !== bType) {
    return aType.localeCompare(bType);
  }

  return String(a).localeCompare(String(b));
}

/**
 * PathMap - A Map implementation with structural key equality.
 *
 * Supports keys that are:
 * - PlexusModel instances (identity by object reference, singleton guarantee)
 * - Primitives (string, number, boolean, null)
 * - Set<above> (unordered - canonical form via sorting)
 * - Array<above> (ordered - sequence matters)
 *
 * Uses separate trie roots for flat/set/array keys to prevent type collisions.
 * Uses WeakMap for model keys and WeakRefs for stored keys, allowing GC of orphaned entries.
 * Maintains insertion order for iteration via stored key list.
 */
export class PathMap<K extends AllowedYJSMapKey, V extends AllowedYJSValue> implements Map<K, V> {
  private flatRoot: TrieNode<K, V> = createNode();
  private setRoot: TrieNode<K, V> = createNode();
  private arrayRoot: TrieNode<K, V> = createNode();

  private readonly storedKeys = new Map<number, Readonly<K>>();
  private nextKeyId = 0;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  get [Symbol.toStringTag](): string {
    return "PathMap";
  }

  maybeGetCanonicalNode(key: K) {
    let current: TrieNode<K, V> = this.getRootForKey(key);
    for (const element of this.keyToPath(key)) {
      if (!current.children.has(element)) {
        return;
      }
      current = current.children.get(element);
    }
    return current;
  }

  maybeGetCanonicalKey(key: K): K | undefined {
    const node = this.maybeGetCanonicalNode(key);
    return node ? this.resolveCanonicalKey(node.canonicalKey) : undefined;
  }

  getCanonicalNode(key: K) {
    let current = this.getRootForKey(key);
    for (const element of this.keyToPath(key)) {
      current = current.children.get(element);
    }
    return current;
  }

  getCanonicalKey(key: K): K {
    const node = this.getCanonicalNode(key);
    const resolved = this.resolveCanonicalKey(node.canonicalKey);
    // If WeakRef was GC'd, create new canonical key
    if (resolved === undefined) {
      let canonicalKey: K;
      if (key instanceof Set) {
        canonicalKey = new Set([...key].sort(canonicalSort)) as K;
      } else if (Array.isArray(key)) {
        canonicalKey = Object.freeze([...key]) as K & ReadonlyArray<K[keyof K]>;
      } else {
        canonicalKey = key;
      }
      node.canonicalKey = canonicalKey;
      return canonicalKey;
    }
    return resolved;
  }

  get(key: K): V | undefined {
    return this.maybeGetCanonicalNode(key)?.value;
  }

  set(key: K, value: V): this {
    const node = this.getCanonicalNode(key);

    if (node.value === undefined) {
      // New entry
      node.keyId = this.nextKeyId++;
      this._size++;
      let canonicalKey: K;
      if (key instanceof Set) {
        canonicalKey = new Set([...key].sort(canonicalSort)) as K;
      } else if (Array.isArray(key)) {
        canonicalKey = Object.freeze([...key]) as K & ReadonlyArray<K[keyof K]>;
      } else {
        canonicalKey = key;
      }
      this.storedKeys.set(node.keyId, canonicalKey);
      node.canonicalKey = canonicalKey;
    }

    node.value = value;
    return this;
  }

  has(key: K): boolean {
    return this.maybeGetCanonicalNode(key)?.value !== undefined;
  }

  delete(key: K): boolean {
    const node = this.maybeGetCanonicalNode(key);
    if (node?.value === undefined) {
      return false;
    }

    // Clean up storedKeys to prevent memory leak in iteration
    if (node.keyId !== undefined) {
      this.storedKeys.delete(node.keyId);
    }

    node.value = undefined;
    node.keyId = undefined;

    // Convert canonicalKey to WeakRef for objects (Set, Array) so it can be GC'd
    // but still available for key comparison if something else holds reference
    const canonicalKey = node.canonicalKey;
    if (canonicalKey instanceof Set || Array.isArray(canonicalKey)) {
      node.canonicalKey = new WeakRef(canonicalKey as K & object);
    }
    // For primitives and PlexusModel, keep as-is (primitives are cheap, models are singletons)

    this._size--;
    return true;
  }

  clear(): void {
    this.flatRoot = createNode();
    this.setRoot = createNode();
    this.arrayRoot = createNode();
    this.storedKeys.clear();
    this._size = 0;
  }

  *keys(): MapIterator<K> {
    for (const key of this.storedKeys.values()) {
      yield key;
    }
  }

  *values(): MapIterator<V> {
    for (const key of this.storedKeys.values()) {
      yield this.getCanonicalNode(key).value!;
    }
  }

  *entries(): MapIterator<[K, V]> {
    for (const key of this.storedKeys.values()) {
      yield [key, this.getCanonicalNode(key).value!] as const;
    }
  }

  forEach<T extends Map<K, V>>(this: T, callback: (value: V, key: K, map: T) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) {
      if (thisArg) {
        callback.call(thisArg, value, key, this);
      } else {
        callback(value, key, this);
      }
    }
  }

  [Symbol.iterator]<T extends Map<K, V>>(this: T): MapIterator<[K, V]> {
    return this.entries();
  }

  /**
   * Get the appropriate trie root for a key type.
   */
  private getRootForKey(key: K): TrieNode<K, V> {
    if (key instanceof Set) {
      return this.setRoot;
    }
    if (Array.isArray(key)) {
      return this.arrayRoot;
    }
    return this.flatRoot;
  }

  /**
   * Convert a key to a normalized path for trie traversal.
   * Sets are sorted for canonical form, arrays preserve order.
   * Validates all elements are allowed types.
   */
  private keyToPath(key: K): AllowedYJSValue[] {
    if (key instanceof Set) {
      const elements = [...key].sort(canonicalSort);
      for (const el of elements) validateKeyElement(el);
      return elements;
    }
    if (Array.isArray(key)) {
      for (const el of key) validateKeyElement(el);
      return key;
    }
    // Single value - validate it
    validateKeyElement(key);
    return [key];
  }

  /**
   * Resolve canonicalKey from node, handling WeakRef case.
   */
  private resolveCanonicalKey(canonicalKey: K | WeakRef<K & object> | undefined): K | undefined {
    if (canonicalKey instanceof WeakRef) {
      return canonicalKey.deref();
    }
    return canonicalKey;
  }
}
