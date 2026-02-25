import invariant from "tiny-invariant";

import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { getInternals, type PlexusConstructor, PlexusModel, safeUuid } from "./PlexusModel.js";
import { buildArrayProxy } from "./proxies/materialized-array.js";
import { buildMapProxy } from "./proxies/materialized-map.js";
import { buildRecordProxy } from "./proxies/materialized-record.js";
import { buildSetProxy } from "./proxies/materialized-set.js";
import {
  type AllowedPrimitive,
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type GenericRecordSchema,
  informAdoptionSymbol,
  type PlexusTagContainer,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "./proxy-runtime-types.js";
import { __untracked__, trackAccess, trackModification } from "./tracking.js";
import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import { maybeReference, maybeTransacting } from "./utils/utils.js";
import { DiscriminateMap, DiscriminateValue, Mapping } from "./decorator-types.js";

const argsAreClassDecoratorArgs = <Model extends PlexusModel, T extends AllowedYJSValue>(
  args:
    | [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>]
    | [ClassAccessorDecoratorTarget<Model, T>, ClassAccessorDecoratorContext<Model, T> & { name: string }],
): args is [PlexusConstructor<Model>, ClassDecoratorContext<PlexusConstructor<Model>>] => args[1].kind === "class";

try {
  // @ts-expect-error this is letting compiled stage-3 decorators work in wrangler dev environment
  // for some unclear reason, flag that needs enabling Symbol.metadata do not work or work weirdly in miniflare
  // since we're relying on its presence, it's better to introduce it anyway - it should not have any
  // negative consequences
  // noinspection JSConstantReassignment
  Symbol.metadata ??= Symbol.for("metadata");
} finally {
  /* empty */
}

const decoratedTracker = new WeakSet<PlexusConstructor>();

function syncingDecorator<
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  TargetConstructor extends PlexusConstructor<Model>,
>(
  ...args: [TargetConstructor, ClassDecoratorContext<PlexusConstructor<Model>>]
): TargetConstructor & PlexusTagContainer<"decorated">;
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
    const proto = Reflect.getPrototypeOf(target)! as PlexusConstructor;
    if (proto !== PlexusModel) {
      invariant(
        proto.prototype instanceof PlexusModel,
        `Plexus<${target.name}>: parent class ${proto.name} is not a PlexusModel`,
      );
      invariant(
        decoratedTracker.has(proto as PlexusConstructor),
        `Plexus<${target.name}>: parent class ${proto.name} must also use @syncing decorator`,
      );
    }
    decoratedTracker.add(target);
    /**
     * NOTE: this is not valid anymore; yet, the problem remains. We're solving it differently now
     * Sometimes, user-defined classes may adjust constructor logic; e.g.:
     * class Code extends PlexusModel {
     *   constructor(code: string = "void 0") {
     *     validateCodeIsCorrect(code);
     *     super({code});
     *   }
     * }
     *
     * in order to keep the capability to spawn the models even if constructor is different,
     * we dynamically switch the prototype to Object during "bypass mode" (where we rehydrate backed classes).
     * This allows us to access private fields - typical Object.create(Class.prototype) or Reflect.setPrototypeOf(target, Class.prototype)
     * is not working for private fields, so this is only option here.
     */
    context.addInitializer(() => {
      /**
       * problem here is, decorators are executed BEFORE static declarations.
       * this mean it's impossible to directly do something like
       * @syncing
       * class Model extends PlexusModel {
       *   static modelName = "Model";
       * }
       * to override things - modelName will simply be not present at moment
       * of @syncing decorator call. Thus, we need to use initializer.
       */
      const name = Object.hasOwn(target, "modelName") ? target.modelName : (context.name ?? target.modelName);
      invariant(name, `Plexus<${target.name}>: class requires a modelName`);
      target.modelName = name;
      target.schema = {} as GenericRecordSchema;
      // it may miss with "barrel" nodes
      if (context.metadata.schema) {
        // we specifically need for...in to traverse over the inherited fields too
        for (const key in context.metadata.schema) {
          target.schema[key] = context.metadata.schema[key];
        }
      }
      invariant(
        !entityClasses.has(target.modelName),
        `Plexus<${target.modelName}>: duplicate class name, must be unique`,
      );
      entityClasses.set(target.modelName, target);
    });
    return target as PlexusConstructor<Model> & PlexusTagContainer<"decorated">;
  } else {
    const [target, context] = args as [
      ClassAccessorDecoratorTarget<Model, T>,
      ClassAccessorDecoratorContext<Model, T> & { name: string },
    ];
    ensureSchema(context)[context.name] = "val";
    return createHandlers(context) as ClassAccessorDecoratorResult<Model, T>;
  }
}

const set = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string },
>(
  context: Context,
  object: Model,
  value: T,
) => {
  const internals = getInternals(object);
  invariant(
    !internals.isDependency,
    `Plexus<${object.__type__}#${safeUuid(object)}.${context.name}>: dependencies are readonly`,
  );
  const storedValue = internals.backingStorage.get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object.__doc__, () => {
    if (value == undefined) {
      internals.backingStorage.delete(context.name);
    } else {
      internals.backingStorage.set(context.name, value);
    }
    if (value == undefined) {
      object.__yjsFieldsMap__?.delete(context.name);
    } else {
      object.__yjsFieldsMap__?.set(context.name, maybeReference(value, object.__doc__!));
    }
    trackModification(object, context.name);
  });
};
const setChild = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string },
>(
  context: Context,
  object: Model,
  value: T,
) => {
  const internals = getInternals(object);
  invariant(
    !internals.isDependency,
    `Plexus<${object.__type__}#${safeUuid(object)}.${context.name}>: dependencies are readonly`,
  );
  const storedValue = internals.backingStorage.get(context.name) as T;
  if (storedValue === value) {
    return;
  }

  /**
   * We're failing early here. We need to understand whether this will crash before we will do any changes.
   * This mean that we cannot rely on in-motion crashes as state will be mutated already.
   * So, before any write action we are checking whether it's OK.
   */
  if (value instanceof PlexusModel) {
    value[validateAdoptionSymbol](object, context.name);
  }

  maybeTransacting(object.__doc__, () => {
    storedValue?.[requestOrphanizationSymbol]?.();
    // old: orphan inside storage, new: attached to old parent
    if (value == undefined) {
      internals.backingStorage.delete(context.name);
    } else {
      internals.backingStorage.set(context.name, value);
    }
    // for that flow, we could've used [requestAdoptionSymbol], but it has some extra checks we just skip
    // old: orphan, removed, new: placed both inside backing storage and old location, has old parent
    value?.[requestEmancipationSymbol]?.(); // removes using old parent pointer
    // old: orphan, removed, new: removed from old location, only inside backing storage, has old parent
    value?.[informAdoptionSymbol]?.(object, context.name);
    // old: orphan, removed, new: removed from old location, only inside backing storage, has new parent
    if (value == undefined) {
      object.__yjsFieldsMap__?.delete(context.name);
    } else {
      object.__yjsFieldsMap__?.set(context.name, maybeReference(value, object.__doc__!));
    }
    trackModification(object, context.name);
  });
};

/**
 * this seems to be pretty efficient approach, but should be performance-benchmarked.
 * this is (probably) computation-cheap approach for field caching.
 * we need this to dynamically support declaration overrides, e.g.:
 * ```
 * class Parent {@syncing accessor field;}
 * class Child extends Paren {@syncing.child accessor field;}
 * ```
 * (see more details in init() comment)
 *
 * we cannot detect this override in decorator setup phase (we do not have access to class,
 * except in class decorators which is not the case), so we could've either initialize them in init(),
 * or lazily spawn on get() interceptor. Classic time-space problem.
 * This specific approach was not chosen by specific efficiency reason but for being the simplest (out of good ones)
 * way to make it work.
 * This also allows us to generalize decorators behavior, making each of struct decorators being basically
 * `createDecorator(type)` that has uniform behavior (except var/child-var fields).
 * `key` was used as first argument, since we may have uncertain amount of models spawned - and there will probably
 * be more models spawned than keys of all model declarations. This gives us some very minor fixed in-memory overhead.
 * (We know we only create correct fields - so rest of weak maps will be simply unused.)
 * Basically, we just know that we have amount of spawn-router objects being worst case sum(models.fieldsCount).
 * In reality, this amount is even smaller, since different models may have same-named fields (e.g. "name", "children"),
 * and this makes amount of spawn-router objects and factory invocations even less - and making them all happen
 * in init phase rather than runtime (like it would be if PlexusModel would be first arg).
 */
const createBackingStructuresMap = new DefaultedMap((key: string) => ({
  set: new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: false })),
  "child-set": new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: true })),
  record: new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: false })),
  "child-record": new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: true })),
  list: new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: false })),
  "child-list": new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: true })),
  map: new DefaultedWeakMap((owner: PlexusModel) => buildMapProxy({ owner, key, isChildField: false })),
  "child-map": new DefaultedWeakMap((owner: PlexusModel) => buildMapProxy({ owner, key, isChildField: true })),
}));

const emptyEphemeralDependency = new DefaultedWeakMap(() => Object.freeze({}));

// this madman grade stuff is needed as we may have inheriting decorators overriding type,
// yet decorator factories are using parent declaration, not child declaration.
// by making that behavior dynamic we make overriding possible
const createHandlers = <
  Model extends PlexusModel,
  T extends
    | AllowedYJSValue
    | Set<AllowedYJSValue>
    | AllowedYJSValue[]
    | Record<string, AllowedYJSValue>
    | Map<AllowedYJSMapKey, AllowedYJSValue>,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string } = ClassAccessorDecoratorContext<
    Model,
    T
  > & { name: string },
>(
  context: Context,
) => {
  // we need those backing structures to be spawned individually to make them isolated per-key
  const backingStructures = createBackingStructuresMap.get(context.name);
  return {
    get(this: Model): T {
      const internals = getInternals(this);
      invariant(
        !internals.isDependency,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: dependencies are handled via special flow overriding this getter. This error should not happen`,
      );
      if (context.name === "dependencies" && this.isRoot) {
        if (this.__doc__) {
          return docPlexus.get(this.__doc__)!.rootDependenciesRepresentation as T;
        } else {
          emptyEphemeralDependency.get(this);
        }
      }
      invariant(
        !internals.isDematerialized,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: model was dematerialized by undo; check whether you are using fresh models directly vs via path from root`,
      );
      // Dematerialized models can still be read (returns presync state)
      trackAccess(this, context.name);
      switch (this.__schema__[context.name]) {
        case "val":
        case "child-val":
          return internals.backingStorage.get(context.name) ?? null;
        default:
          /** see "We are doing dynamic schema retrieval..." comment below in init()*/
          return backingStructures[this.__schema__[context.name]].get(this);
      }
    },
    set(this: Model, value: T) {
      const internals = getInternals(this);
      invariant(
        !internals.isDependency,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: dependencies are handled via special flow overriding this setter. This error should not happen`,
      );
      invariant(
        !internals.isDematerialized,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: model was dematerialized by undo; check whether you are using fresh models directly vs via path from root`,
      );
      if (this.__schema__[context.name] === "val") {
        set(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      if (this.__schema__[context.name] === "child-val") {
        setChild(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      /** see "We are doing dynamic schema retrieval..." comment below in init()*/
      backingStructures[this.__schema__[context.name]].get(this).assign(value);
    },
    /**
     * We're doing this overkill-looking init sequence to basically hack the JavaScript.
     * the initiation sequence of classes are clear: parent constructors executes first, then child constructors.
     * but that means that we cannot define default values while using prop initializer like that:
     *
     * class A extends PlexusModel {
     *   @syncing accessor field: number = 42;
     * }
     *
     * new A({field: 69}) // nice
     *
     * as the execution sequence like that:
     * (this: PlexusModel).field = 69;
     * (this: A).field = 42;
     *
     * To bypass this, the init hook of stage-3 decorators was used that lets us manually control initiation sequence.
     * So, now it works like that (very simplified):
     * constructor () {
     *    PlexusModel: {
     *      this._initializationState.field = 69;
     *    }
     *    A: {
     *      field.@syncingDecorator.init(defaultValue: 42) {
     *        this.field = this._initializationState.field ?? defaultValue
     *      }
     *    }
     * }
     *
     * However, this highlighted another problem with modern TS/JS behavior:
     * ```
     * class Model {
     *   field: string;
     * }
     * ```
     * is compiled by default (since TS 5.6+ or 5.7+ - unsure about that) not to `class Model {}`, but to
     * ```
     * class Model {
     *   field;
     * }
     * ```
     * this looks safe, but this is what is this declaration is actually doing:
     * ```
     * class Model {
     *   constructor() {
     *     this.field = undefined;
     *   }
     * }
     * ```
     *
     * In real world scenarios, this leaded to very specific problem with inheritance that looks like that:
     * ```
     * @syncing
     * class Component extends PlexusModel {
     *   @syncing
     *   accessor type: "page" | "component" = "page";
     * }
     * ```
     * @syncing
     * class CodeComponent {
     *  type: "component";
     * }
     * ```
     * We needed to be both able to omit declarations (because, well, everyone forgets about `declare` TS keyword)
     * and support nullification override (e.g. parent is "page", child wants to initialize with `null`).
     * To mitigate it, the general design decision of Plexus - `undefined` is illegal - was applied here.
     * Since you just cannot declare some plexus-syncing field to be `undefined` (decorator type explicitly bans it),
     * we may assume that in normal conditions presence of `undefined` in initializer means that there's no
     * initializer value. Missing initializer clearly means that we can skip this specific initialization value.
     *
     * init() for decorators can be called multiple times (each per class in inheritance chain), parent-to-child,
     * after the constructor but before the new() result is returned back. Thus, we can expect that all of them
     * to exist in safe temporal area, and efficiently be represented as following value to be materialized:
     * this._initializationState[field] ?? child.field ?? parent.field ?? grandparent.field
     * (but if ?? would fallback only on undefined, not null)
     * */
    init(this: Model, value: T): T {
      // we're intentionally skipping
      if (PlexusModel.__isMaterializingRaw__) {
        return undefined as any;
      }
      const internals = getInternals(this);
      if (internals.isDependency) {
        return null as any;
      }
      const setter = this.__schema__[context.name] === "val" ? set : setChild;
      /**
       * ephemeral models may be constructed at mutation-tracking contexts (see createTrackedFunction),
       * read events are always tracked (we need to know what was accessed to make decisions),
       * and nature of construction behavior causes us to do some read requests anyway.
       * This means that need to explicitly initialize the class in a context that silences the mutation reporting.
       * this is not a hack - __untracked__ is legitimate internal function for such use cases.
       * */
      return __untracked__(() => {
        /**
         * We are doing dynamic schema retrieval due to child class decorators may override parent class schema
         * declarations; however, getters seems to be used from parent accessor (stage-3 decorators are pretty
         * nuanced, and it's hard to figure out some edge cases in spec).
         * This problem (child declaration decorator changes schema type) is reproducible
         * So, instead of relying on decorator spawn input, we take actual field type from schema to
         * be sure that we alter the behavior accordingly to actual definition intended.
         */
        switch (this.__schema__[context.name]) {
          case "val":
          case "child-val": {
            /**
             * we support _two_ initialization flows:
             * - new Model({...init}) - ephemeral, public
             * - new Model([entityId: string, doc: Y.Doc]) - materialized, internal
             *
             * in materialized flow, we need to ignore all "init values" and just use data from underlying yjs model.
             * however, constructor args override the yjs model presence as we may sometimes encounter the model
             * assignment during the post-constructor phase. This will clearly mean that we're initializing
             * as a definition, not synced state, and should represent that value.
             */
            if (internals.yjsModel && !internals.isWithinYjsModelSeed) {
              const reflectedValue =
                internals.initializationState[context.name] === undefined
                  ? this[context.name]
                  : internals.initializationState[context.name];
              setter(context, this, reflectedValue);
              return reflectedValue;
            }
            const actualValue =
              // remember, null is valid
              internals.initializationState[context.name] === undefined
                ? // this fixes "override cases" when fields are re-declared without default value - in that case we take already known value instead of undefined
                  value === undefined
                  ? this[context.name]
                  : value
                : internals.initializationState[context.name];
            setter(context as any, this, actualValue as Extract<T, AllowedYJSValue>);
            return actualValue;
          }
          default: {
            /**
             * we must return something, so to avoid code duplication we just redirect init() to get() who does actual logic.
             */
            if (internals.yjsModel && !internals.isWithinYjsModelSeed) {
              return this[context.name];
            }
            // we do not care about undefined vs null here, as syncing structs have null as banned type too,
            // so it's just simpler and more readable to write like that
            const actualValue = internals.initializationState[context.name] ?? value;
            if (actualValue != undefined) {
              backingStructures[this.__schema__[context.name]].get(this).assign(actualValue);
            }
            // this technically goes to accessor private backing field - but we actually do not care a lot about that
            return actualValue;
          }
        }
      });
    },
  };
};

const ensureSchema = (context: ClassAccessorDecoratorContext<PlexusModel, any>): GenericRecordSchema => {
  /**
   * in inheriting classes, first decorator sees that we HAVE context.metadata.schema,
   * but not own one - it is inherited from parent class.
   * Parent class definition expected to be complete at the moment of another declaration,
   * so schema will not change unless dev is some kind of genuine madman
   * (there _are_ ways to declare class mid-declaration of another class).
   * This skill level is respected but not appreciated here.
   *
   * However, to increase soundness (and solve even those cases, because who knows what hacks devs can actually do),
   * we use parent schema as prototype, not simply clone it.
   */
  if (!Object.hasOwn(context.metadata, "schema")) {
    context.metadata.schema = {
      __proto__: context.metadata.schema ?? {},
    };
  }
  return context.metadata.schema as GenericRecordSchema;
};

const buildDecorator = <MappingType extends keyof Mapping<any>>(kind: GenericRecordSchema[string]) =>
  Object.assign(
    function plexusDynamicDecorator<
      Model extends PlexusModel,
      FieldValue extends AllowedPrimitive | PlexusModel,
      Struct extends Mapping<FieldValue>[MappingType],
    >(
      target: ClassAccessorDecoratorTarget<Model, Struct>,
      context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
    ) {
      ensureSchema(context)[context.name] = kind;
      return createHandlers<Model, Struct>(context);
    },
    {
      declare<Out extends Mapping<AllowedPrimitive | PlexusModel>[MappingType], In extends Out>() {
        return function plexusDynamicDecorator<Model extends PlexusModel>(
          target: ClassAccessorDecoratorTarget<Model, Out>,
          context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
        ) {
          ensureSchema(context)[context.name] = kind;
          return createHandlers<Model, Out>(context) as {
            get?(this: Model): Out;
            set?(this: Model, value: In): void;
            init?(this: Model, value: In): In;
          };
        };
      },
    },
  );

/** separate function here is done only for better types debugging; no other purpose intended */
const buildDiscriminatingDecorator = <MappingType extends keyof Mapping<any>>(kind: GenericRecordSchema[string]) =>
  Object.assign(
    function plexusDynamicDecorator<
      Model extends PlexusModel,
      /**
       * The problem we're solving here is that PlexusModel<A | B> is not matching PlexusModel<B>;
       * yet we cannot just generalize types. So, we infer two types - FieldValue, that is produced from usage,
       * and discriminator, that defines what FieldValue is allowed to be. Since we have 2 args, we can make first one
       * produce FieldValue, and second one to act as discriminator. (decorators are weird; maybe there's more efficient
       * way to solve it, but it's very hard to debug decorator types)
       */
      Value extends Mapping<AllowedYJSValue>[MappingType],
    >(
      target: ClassAccessorDecoratorTarget<Model, DiscriminateValue<MappingType, Value, Model>>,
      context: ClassAccessorDecoratorContext<Model, Value> & { name: string },
    ) {
      ensureSchema(context)[context.name] = kind;
      return createHandlers<Model, Value>(context);
    },
    {
      // todo narrow down
      declare<Out extends Mapping<AllowedPrimitive | PlexusModel>[MappingType], In extends Out>() {
        return function plexusDynamicDecorator<Model extends PlexusModel>(
          target: ClassAccessorDecoratorTarget<PlexusModel, Out>,
          context: ClassAccessorDecoratorContext<PlexusModel, Out> & { name: string },
        ) {
          ensureSchema(context)[context.name] = kind;
          return createHandlers<Model, Out>(context) as {
            get?(this: Model): Out;
            set?(this: Model, value: In): void;
            init?(this: Model, value: In): In;
          };
        };
      },
    },
  );

export const syncing = Object.assign(syncingDecorator, {
  child: Object.assign(buildDiscriminatingDecorator<"identity">("child-val"), {
    record: buildDiscriminatingDecorator<"record">("child-record"),
    set: buildDiscriminatingDecorator<"set">("child-set"),
    list: buildDiscriminatingDecorator<"list">("child-list"),
    /**
     * Specialized decorator for Map fields where values are tracked as children.
     * Provides parent-child ownership tracking for map values.
     */
    map<Model extends PlexusModel, Field extends Map<any, any>>(
      target: ClassAccessorDecoratorTarget<Model, Field>,
      context: ClassAccessorDecoratorContext<Model, DiscriminateMap<Field, Model>> & {
        name: string;
      },
    ) {
      ensureSchema(context)[context.name] = "child-map";
      return createHandlers<Model, DiscriminateMap<Field, Model>>(context);
    },
  }),
  record: buildDecorator<"record">("record"),
  set: buildDecorator<"set">("set"),
  list: buildDecorator<"list">("list"),

  /**
   * Specialized decorator for Map fields that preserves both key and value types.
   * Returns PlexusMap which extends Map with bulk operations like assign().
   */
  map<Model extends PlexusModel, FieldValueKey extends AllowedYJSMapKey, FieldValue extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, Map<FieldValueKey, FieldValue>>,
    context: ClassAccessorDecoratorContext<Model, Map<FieldValueKey, FieldValue>> & { name: string },
  ) {
    ensureSchema(context)[context.name] = "map";
    return createHandlers<Model, Map<FieldValueKey, FieldValue>>(context);
  },

  declare<Out extends AllowedPrimitive | PlexusModel, In extends Out>() {
    return function plexusDynamicDecorator<Model extends PlexusModel>(
      target: ClassAccessorDecoratorTarget<Model, Out>,
      context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
    ) {
      ensureSchema(context)[context.name] = "val";
      return createHandlers<Model, Out>(context) as {
        get?(this: Model): Out;
        set?(this: Model, value: In): void;
        init?(this: Model, value: In): In;
      };
    };
  },
});
