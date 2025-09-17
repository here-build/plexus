import { PlexusConstructor, PlexusModel } from "./PlexusModel";
import {
  AllowedYJSValue,
  AllowedYValue,
  backingStorageSymbol,
  GenericRecordSchema,
  informAdoptionSymbol,
  ReadonlyField,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { entityClasses } from "./globals";
import { trackAccess, trackModification } from "./tracking";
import { DefaultedWeakMap, maybeReference } from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";
import { deref } from "./deref";

function syncingDecorator<Model extends PlexusModel>(
  ...args: [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
): PlexusConstructor<Model>;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args: [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
): ClassAccessorDecoratorResult<Model, T>;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args:
    | [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
    | [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
): PlexusConstructor<Model> | ClassAccessorDecoratorResult<Model, T> {
  if (args[1].kind === "class") {
    const [target, context] = args as [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>];
    invariant(context.name ?? target.name, "Plexus class should have designated name");
    target.modelName = context.name ?? target.name;
    target.schema = context.metadata.schema as GenericRecordSchema;
    invariant(!entityClasses.has(target.modelName), `Plexus class name ${target.modelName} is non-unique`);
    entityClasses.set(target.modelName, target);
    return target;
  } else {
    const [target, context] = args as [
      ClassAccessorDecoratorTarget<Model, T>,
      ClassAccessorDecoratorContext<Model, T> & { name: string }
    ];
    const schema = (context.metadata.schema ??= {}) as GenericRecordSchema;
    if (schema[context.name]) {
      invariant(schema[context.name] === "val");
      // @ts-expect-error
      return;
    }
    schema[context.name] = "val";

    const storage = new DefaultedWeakMap((target: Model) => {
      let value: T;
      return (target[backingStorageSymbol][context.name] = {
        get() {
          return value;
        },
        set(newValue) {
          let changed = newValue !== value;
          value = newValue;
          return changed;
        }
      });
    });

    return {
      get(this: Model) {
        trackAccess(this, context.name);
        return this._yjsModel?.doc
          ? (deref(this._yjsModel.doc, this._yjsModel.get(context.name) as AllowedYValue | undefined) as T)
          : storage.get(this).get();
      },
      set(this: Model, value) {
        const storedValue = storage.get(this).get();
        if (storedValue === value) {
          return;
        }
        trackModification(this, context.name);
        storage.get(this).set(value);
        if (value === undefined) {
          this._yjsModel?.delete(context.name);
        } else {
          this._yjsModel?.set(context.name, maybeReference(value, this._doc!));
        }
      },
      init(this: Model, value: T) {
        if (!storage.has(this)) {
          storage.get(this).set(value);
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
      ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "child-val";
      const storage = new DefaultedWeakMap((target: Model) => {
        let value: T;
        return (target[backingStorageSymbol][context.name] = {
          get() {
            return value;
          },
          set(newValue: T) {
            value = newValue;
          }
        });
      });

      return {
        get(this: Model) {
          trackAccess(this, context.name);
          return this._yjsModel?.doc
            ? (deref(this._yjsModel.doc, this._yjsModel.get(context.name) as AllowedYValue | undefined) as T)
            : storage.get(this).get();
        },
        set(this: Model, value: T) {
          const storedValue = storage.get(this).get();
          if (storedValue === value) {
            return;
          }
          trackModification(this, context.name);
          storedValue?.[requestOrphanizationSymbol]?.();
          storage.get(this).set(value);
          value?.[requestAdoptionSymbol]?.(this, context.name);
          if (value === undefined) {
            this._yjsModel?.delete(context.name);
          } else {
            this._yjsModel?.set(context.name, maybeReference(value, this._doc!));
          }
        },
        init(this: Model, value: T) {
          if (!storage.has(this)) {
            storage.get(this).set(value);
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
        ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "child-record";
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
            return value ?? {};
          }
        };
      },
      set: function syncingChildSetDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
        target: ClassAccessorDecoratorTarget<Model, Set<T>>,
        context: ClassAccessorDecoratorContext<Model, Set<T>> & { name: string }
      ): ClassAccessorDecoratorResult<Model, Set<T> & ReadonlyField<Set<T>>> {
        ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "child-set";
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
            return value ?? new Set();
          }
        };
      },
      list: function syncingChildListDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
        target: ClassAccessorDecoratorTarget<Model, T[]>,
        context: ClassAccessorDecoratorContext<Model, T[]> & { name: string }
      ): ClassAccessorDecoratorResult<Model, T[] & ReadonlyField<T[]>> {
        ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "child-list";
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
    ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "record";
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
        return value ?? {};
      }
    };
  },
  set: function syncingSetDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, Set<T>>,
    context: ClassAccessorDecoratorContext<Model, Set<T>> & { name: string }
  ): ClassAccessorDecoratorResult<Model, Set<T> & ReadonlyField<Set<T>>> {
    ((context.metadata.schema ??= {}) as Record<string, any>)[context.name] = "set";
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
        return value ?? new Set();
      }
    };
  },
  list: function syncingListDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, T[]>,
    context: ClassAccessorDecoratorContext<Model, T[]> & { name: string }
  ): ClassAccessorDecoratorResult<Model, T[] & ReadonlyField<T[]>> {
    const schema = (context.metadata.schema ??= {}) as GenericRecordSchema;
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
        invariant(!this._constructionComplete, `you cannot directly assign ${this.constructor.name}.${context.name}`);
        backingStructures.get(this).assign(value);
      },
      init(value) {
        return value ?? [];
      }
    };
  }
});
