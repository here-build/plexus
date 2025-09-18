import { PlexusConstructor, PlexusModel } from "./PlexusModel";
import {
  AllowedYJSValue,
  backingStorageSymbol,
  GenericRecordSchema,
  informAdoptionSymbol,
  ReadonlyField,
  requestEmancipationSymbol,
  requestOrphanizationSymbol
} from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { entityClasses } from "./globals";
import { trackAccess, trackModification } from "./tracking";
import { DefaultedWeakMap, maybeReference, maybeTransacting } from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";

const argsAreClassDecoratorArgs = <Model extends PlexusModel, T extends AllowedYJSValue>(
  args:
    | [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
    | [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
): args is [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>] => args[1].kind === "class";

function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue, Constructor extends PlexusConstructor<Model>>(
  ...args: [Constructor, ClassDecoratorContext<PlexusConstructor<Model>>]
): Constructor;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args: [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
): ClassAccessorDecoratorResult<Model, T>;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args:
    | [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
    | [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
) {
  if (argsAreClassDecoratorArgs(args)) {
    const [target, context] = args as [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>];
    const name = context.name ?? target.name;
    invariant(name, "Plexus class should have designated name");
    invariant(context.metadata.schema, `there's no schema of model ${name} to sync`);
    target.modelName = name;
    target.schema = {} as GenericRecordSchema;
    // we specifically need for...in to traverse over the inherited fields too
    for (const key in context.metadata.schema) {
      target.schema[key] = context.metadata.schema[key];
    }
    invariant(!entityClasses.has(target.modelName), `Plexus class name ${target.modelName} is non-unique`);
    entityClasses.set(target.modelName, target);
    return target;
  } else {
    const [target, context] = args as [
      ClassAccessorDecoratorTarget<Model, T>,
      ClassAccessorDecoratorContext<Model, T> & { name: string }
    ];
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {}
      };
    }
    const schema = context.metadata.schema as GenericRecordSchema;
    if (schema[context.name]) {
      invariant(schema[context.name] === "val");
      // we need to return undefined that is half-baked in spec but means "please do not apply decorator"
      return undefined as any as ClassAccessorDecoratorResult<Model, T>;
    }
    schema[context.name] = "val";

    const set = (object: Model, value: T) => {
      const storedValue = object[backingStorageSymbol].get(context.name);
      if (storedValue === value) {
        return;
      }
      trackModification(object, context.name);
      object[backingStorageSymbol].set(context.name, value);
      if (value === undefined) {
        object._yjsModel?.delete(context.name);
      } else {
        object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
      }
    };

    return {
      get(this: Model) {
        trackAccess(this, context.name);
        return this[backingStorageSymbol].get(context.name);
      },
      set(this: Model, value) {
        set(this, value);
      },
      init(this: Model, value: T) {
        if (this._constructionComplete && this[context.name] === undefined && value !== undefined) {
          set(this, value);
        }
        return value;
      }
    };
  }
}

export const syncing = Object.assign(syncingDecorator, {
  child: Object.assign(
    function syncingChildDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
      target: ClassAccessorDecoratorTarget<Model, T>,
      context: ClassAccessorDecoratorContext<Model, T> & { name: string }
    ) {
      if (!Object.hasOwn(context.metadata, "schema")) {
        context.metadata.schema = {
          // it may be coming from inherited state and we need to use the inheritance here too
          __proto__: context.metadata.schema ?? {}
        };
      }
      const schema = context.metadata.schema as GenericRecordSchema;
      schema[context.name] = "child-val";
      const set = (object: Model, value: T) => {
        const storedValue = object[backingStorageSymbol].get(context.name) as T;
        if (storedValue === value) {
          return;
        }
        maybeTransacting(object._doc, () => {
          storedValue?.[requestOrphanizationSymbol]?.();
          if (value === undefined) {
            object[backingStorageSymbol].delete(context.name);
          } else {
            object[backingStorageSymbol].set(context.name, value);
          }
          value?.[requestEmancipationSymbol]?.();
          value?.[informAdoptionSymbol]?.(object, context.name);
          trackModification(object, context.name);
          if (value === undefined) {
            object._yjsModel?.delete(context.name);
          } else {
            object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
          }
        });
      };
      return {
        get(this: Model) {
          trackAccess(this, context.name);
          return this[backingStorageSymbol].get(context.name);
        },
        set(this: Model, value: T) {
          set(this, value);
        },
        init(this: Model, value: T) {
          if (this._constructionComplete && this[context.name] === undefined && value !== undefined) {
            set(this, value);
          }
          return value;
        }
      };
    },
    {
      map: function syncingChildMapDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
        target: ClassAccessorDecoratorTarget<Model, Record<string, T>>,
        context: ClassAccessorDecoratorContext<Model, Record<string, T>> & { name: string }
      ): ClassAccessorDecoratorResult<Model, Record<string, T> & ReadonlyField<Record<string, T>>> {
        if (!Object.hasOwn(context.metadata, "schema")) {
          context.metadata.schema = {
            // it may be coming from inherited state and we need to use the inheritance here too
            __proto__: context.metadata.schema ?? {}
          };
        }
        const schema = context.metadata.schema as GenericRecordSchema;
        schema[context.name] = "child-record";
        const backingStructures = new DefaultedWeakMap((owner: Model) =>
          buildRecordProxy({ owner, context, isChildField: true })
        );

        return {
          get(this: Model) {
            return backingStructures.get(this);
          },
          set(this: Model, value) {
            invariant(
              !this._constructionComplete,
              `you cannot directly assign ${this.constructor.name}.${context.name}`
            );
            backingStructures.get(this).assign(value);
          },
          init(value) {
            if (!backingStructures.has(this) && value) {
              backingStructures.get(this).assign(value);
            }
            return value ?? {};
          }
        };
      },
      set: function syncingChildSetDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
        target: ClassAccessorDecoratorTarget<Model, Set<T>>,
        context: ClassAccessorDecoratorContext<Model, Set<T>> & { name: string }
      ): ClassAccessorDecoratorResult<Model, Set<T> & ReadonlyField<Set<T>>> {
        if (!Object.hasOwn(context.metadata, "schema")) {
          context.metadata.schema = {
            // it may be coming from inherited state and we need to use the inheritance here too
            __proto__: context.metadata.schema ?? {}
          };
        }
        const schema = context.metadata.schema as GenericRecordSchema;
        schema[context.name] = "child-set";
        const backingStructures = new DefaultedWeakMap((owner: Model) =>
          buildSetProxy({ owner, context, isChildField: true })
        );

        return {
          get(this: Model) {
            return backingStructures.get(this);
          },
          set(this: Model, value) {
            invariant(
              !this._constructionComplete,
              `you cannot directly assign ${this.constructor.name}.${context.name}`
            );
            backingStructures.get(this).assign(value);
          },
          init(value) {
            if (!backingStructures.has(this) && value) {
              backingStructures.get(this).assign(value);
            }
            return value ?? new Set();
          }
        };
      },
      list: function syncingChildListDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
        target: ClassAccessorDecoratorTarget<Model, T[]>,
        context: ClassAccessorDecoratorContext<Model, T[]> & { name: string }
      ): ClassAccessorDecoratorResult<Model, T[] & ReadonlyField<T[]>> {
        if (!Object.hasOwn(context.metadata, "schema")) {
          context.metadata.schema = {
            // it may be coming from inherited state and we need to use the inheritance here too
            __proto__: context.metadata.schema ?? {}
          };
        }
        const schema = context.metadata.schema as GenericRecordSchema;
        schema[context.name] = "child-list";
        const backingStructures = new DefaultedWeakMap((owner: Model) =>
          buildArrayProxy({ owner, context, isChildField: true })
        );

        return {
          get(this: Model) {
            return backingStructures.get(this);
          },
          set(this: Model, value) {
            invariant(
              !this._constructionComplete,
              `you cannot directly assign ${this.constructor.name}.${context.name}`
            );
            backingStructures.get(this).assign(value);
          },
          init(value) {
            if (!backingStructures.has(this) && value) {
              backingStructures.get(this).assign(value);
            }
            return value ?? [];
          }
        };
      }
    }
  ),
  map: function syncingMapDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, Record<string, T>>,
    context: ClassAccessorDecoratorContext<Model, Record<string, T>> & { name: string }
  ): ClassAccessorDecoratorResult<Model, Record<string, T> & ReadonlyField<Record<string, T>>> {
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {}
      };
    }
    const schema = context.metadata.schema as GenericRecordSchema;
    schema[context.name] = "record";
    const backingStructures = new DefaultedWeakMap((owner: Model) =>
      buildRecordProxy({ owner, context, isChildField: false })
    );

    return {
      get(this: Model) {
        return backingStructures.get(this);
      },
      set(this: Model, value) {
        invariant(!this._constructionComplete, `you cannot directly assign ${this.constructor.name}.${context.name}`);
        backingStructures.get(this).assign(value);
      },
      init(value) {
        if (!backingStructures.has(this) && value) {
          backingStructures.get(this).assign(value);
        }
        return value ?? {};
      }
    };
  },
  set: function syncingSetDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, Set<T>>,
    context: ClassAccessorDecoratorContext<Model, Set<T>> & { name: string }
  ): ClassAccessorDecoratorResult<Model, Set<T> & ReadonlyField<Set<T>>> {
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {}
      };
    }
    const schema = context.metadata.schema as GenericRecordSchema;
    schema[context.name] = "set";
    const backingStructures = new DefaultedWeakMap((owner: Model) =>
      buildSetProxy({ owner, context, isChildField: false })
    );

    return {
      get(this: Model) {
        return backingStructures.get(this);
      },
      set(this: Model, value) {
        invariant(!this._constructionComplete, `you cannot directly assign ${this.constructor.name}.${context.name}`);
        backingStructures.get(this).assign(value);
      },
      init(value) {
        if (!backingStructures.has(this) && value) {
          backingStructures.get(this).assign(value);
        }
        return value ?? new Set();
      }
    };
  },
  list: function syncingListDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, T[]>,
    context: ClassAccessorDecoratorContext<Model, T[]> & { name: string }
  ): ClassAccessorDecoratorResult<Model, T[] & ReadonlyField<T[]>> {
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {}
      };
    }
    const schema = context.metadata.schema as GenericRecordSchema;
    if (schema[context.name]) {
      invariant(schema[context.name] === "list");
      // @ts-expect-error
      return;
    }
    schema[context.name] = "list";
    const backingStructures = new DefaultedWeakMap((owner: Model) =>
      buildArrayProxy({ owner, context, isChildField: false })
    );

    return {
      get(this: Model) {
        return backingStructures.get(this);
      },
      set(this: Model, value) {
        backingStructures.get(this).assign(value);
      },
      init(value) {
        if (!backingStructures.has(this) && value) {
          backingStructures.get(this).assign(value);
        }
        return value ?? [];
      }
    };
  }
});
