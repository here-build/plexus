import { PlexusConstructor, PlexusModel } from "./PlexusModel";
import {
  AllowedYJSValue,
  GenericRecordSchema,
  informAdoptionSymbol,
  ReadonlyField,
  requestOrphanizationSymbol
} from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { entityClasses } from "./globals";
import { trackAccess, trackModification } from "./tracking";
import { DefaultedWeakMap, maybeReference } from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";

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
    const schema = (context.metadata.schema ??= {}) as GenericRecordSchema
    if (schema[context.name]) {
      invariant(schema[context.name] === "val");
      // @ts-expect-error
      return;
    }
    schema[context.name] = "val";
    const storage = new DefaultedWeakMap((target: Model) => {
      let value: T;
      return {
        get() {
          return value;
        },
        set(newValue) {
          let changed = newValue !== value;
          value = newValue;
          return changed;
        }
      };
    });
    context.access.get = (object) => {
      trackAccess(object, context.name);
      return object._yjsModel ? (object._yjsModel.get(context.name) as T) : storage.get(object).get();
    }
    context.access.set = (object, value) => {
      if (storage.get(object).get() === value) {
        return;
      }
      trackModification(object, context.name);
      storage.get(object).set(value);
      if (value === undefined) {
        object._yjsModel?.delete(context.name);
      } else {
        object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
      }
    }

    return {
      get(this: Model) {
        return context.access.get(this);
      },
      set(this: Model, value) {
        context.access.set(this, value);
      },
      init(value) {
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
        return {
          get() {
            return value;
          },
          set(newValue: T) {
            value = newValue;
          },
          init(value: T) {
            return value;
          }
        };
      });

      return {
        get(this: Model) {
          trackAccess(this, context.name);
          return this._yjsModel ? (this._yjsModel.get(context.name) as T) : storage.get(this).get();
        },
        set(this: Model, value) {
          if (storage.get(this).get() === value) {
            return;
          }
          trackModification(this, context.name);
          storage.get(this).get()?.[requestOrphanizationSymbol]?.();
          storage.get(this).set(value);
          if (value === undefined) {
            this._yjsModel?.delete(context.name);
          } else {
            this._yjsModel?.set(context.name, maybeReference(value, this._doc!));
          }
          value?.[informAdoptionSymbol]?.();
        },
        init(value) {
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
            if (!this._constructionComplete) {
              backingStructures.get(this).assign(value);
            } else {
              throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
            }
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
            if (!this._constructionComplete) {
              backingStructures.get(this).assign(value);
            } else {
              throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
            }
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
            if (!this._constructionComplete) {
              backingStructures.get(this).assign(value);
            } else {
              throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
            }
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
        if (!this._constructionComplete) {
          backingStructures.get(this).assign(value);
        } else {
          throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
        }
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
        if (!this._constructionComplete) {
          backingStructures.get(this).assign(value);
        } else {
          throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
        }
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
    const schema = (context.metadata.schema ??= {}) as GenericRecordSchema
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
        if (!this._constructionComplete) {
          backingStructures.get(this).assign(value);
        } else {
          throw new Error(`you cannot directly assign ${this.constructor.name}.${context.name}`);
        }
      },
      init(value) {
        return value ?? [];
      }
    };
  }
});
