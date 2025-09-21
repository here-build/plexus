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
import { DefaultedMap, DefaultedWeakMap, maybeReference, maybeTransacting } from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";

const argsAreClassDecoratorArgs = <Model extends PlexusModel, T extends AllowedYJSValue>(
  args:
    | [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
    | [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }]
): args is [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>] => args[1].kind === "class";

try {
// this is letting compiled stage-3 decorators work in wrangler environment
// @ts-expect-error
// noinspection JSConstantReassignment
  Symbol.metadata ??= Symbol.for("metadata");
} finally {

}

function syncingDecorator<
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Constructor extends PlexusConstructor<Model>
>(...args: [Constructor, ClassDecoratorContext<PlexusConstructor<Model>>]): Constructor;
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
    (context.metadata.schema as GenericRecordSchema)[context.name] = "val";
    return createHandlers(context) as ClassAccessorDecoratorResult<Model, T>;
  }
}

const set = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string }
>(
  context: Context,
  object: Model,
  value: T
) => {
  const storedValue = object[backingStorageSymbol].get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object._doc, () => {
    if (value == undefined) {
      object[backingStorageSymbol].delete(context.name);
    } else {
      object[backingStorageSymbol].set(context.name, value);
    }
    trackModification(object, context.name);
    if (value == undefined) {
      object._yjsModel?.delete(context.name);
    } else {
      object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
    }
  });
};
const setChild = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string }
>(
  context: Context,
  object: Model,
  value: T
) => {
  const storedValue = object[backingStorageSymbol].get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object._doc, () => {
    storedValue?.[requestOrphanizationSymbol]?.();
    if (value == undefined) {
      object[backingStorageSymbol].delete(context.name);
    } else {
      object[backingStorageSymbol].set(context.name, value);
    }
    value?.[requestEmancipationSymbol]?.();
    value?.[informAdoptionSymbol]?.(object, context.name);
    trackModification(object, context.name);
    if (value == undefined) {
      object._yjsModel?.delete(context.name);
    } else {
      object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
    }
  });
};

const createBackingStructuresMap = new DefaultedMap((key: string) => ({
  set: new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: false })),
  "child-set": new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: true })),
  record: new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: false })),
  "child-record": new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: true })),
  list: new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: false })),
  "child-list": new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: true }))
}));

// this madman grade stuff is needed as we may have inheriting decorators overriding type,
// yet decorator factories are using parent declaration, not child declaration.
// by making that behavior dynamic we make overriding possible
const createHandlers = <
  Model extends PlexusModel,
  T extends AllowedYJSValue | Set<AllowedYJSValue> | AllowedYJSValue[] | Record<string, AllowedYJSValue>,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string }
>(
  context: Context
) => {
  // we need those backing structures to be spawned individually to make them isolated per-key
  const backingStructures = createBackingStructuresMap.get(context.name);
  return {
    get(this: Model) {
      trackAccess(this, context.name);
      switch (this._schema[context.name]) {
        case "val":
        case "child-val":
          return this[backingStorageSymbol].get(context.name) ?? null;
        default:
          return backingStructures[this._schema[context.name]].get(this);
      }
    },
    set(this: Model, value: any) {
      if (this._schema[context.name] === "val") {
        set(context, this, value);
        return;
      }

      if (this._schema[context.name] === "child-val") {
        setChild(context, this, value);
        return;
      }

      backingStructures[this._schema[context.name]].get(this).assign(value);
    },
    init(this: Model, value: any) {
      const setter = this._schema[context.name] === "val" ? set : setChild;
      switch (this._schema[context.name]) {
        case "val":
        case "child-val": {
          if (this._yjsModel) {
            const reflectedValue = this[context.name];
            setter(context, this, reflectedValue);
            return reflectedValue;
          }
          const actualValue = this._initializationState[context.name] ?? value;
          setter(context, this, actualValue);
          return actualValue;
        }
        default:
          if (this._yjsModel) {
            return this[context.name];
          }
          const actualValue = this._initializationState[context.name] ?? value;
          if (actualValue) {
            backingStructures[this._schema[context.name]].get(this).assign(actualValue);
          }
          return actualValue;
      }
    }
  };
};

const buildDecorator = <
  T extends AllowedYJSValue | Set<AllowedYJSValue> | AllowedYJSValue[] | Record<string, AllowedYJSValue>
>(
  kind: GenericRecordSchema[string]
) =>
  function plexusDynamicDecorator<Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<Model, T>,
    context: ClassAccessorDecoratorContext<Model, T> & { name: string }
  ) {
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {}
      };
    }
    (context.metadata.schema as GenericRecordSchema)[context.name] = kind;
    return createHandlers(context);
  };

export const syncing = Object.assign(syncingDecorator, {
  child: Object.assign(buildDecorator<AllowedYJSValue>("child-val"), {
    map: buildDecorator<Record<string, AllowedYJSValue>>("child-record"),
    set: buildDecorator<Set<AllowedYJSValue>>("child-set"),
    list: buildDecorator<Array<AllowedYJSValue>>("child-list")
  }),
  map: buildDecorator<Record<string, AllowedYJSValue>>("record"),
  set: buildDecorator<Set<AllowedYJSValue>>("set"),
  list: buildDecorator<Array<AllowedYJSValue>>("list")
});
