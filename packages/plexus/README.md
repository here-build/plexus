# @here.build/arbor
TODO rename the package itself

Arbor is both a conceptual and programmatic framework for application state management, aiming to solve the biggest
pain points of state management - automatic replication, scoping and debugability - by setupping the middle ground of state.

It provides few primitives on top of well-known ideas and technologies.
To start with, you can think of it as "MobX on top of YJS" or "JS classes but with collaboration and reactivity".
It intentionally resembles the design of MobX while using yjs as CRDT runtime to provide the cross-client sync.

Arbor (referring to Arbor Mundi, "the world tree") is doing exactly that - the app world tree.
By treating the web application (or mobile app, or anything else you want, for example, CLI) as some material representation
of "platonic" application being represented by tree of classes, we become able to narrow down the scope of anything we need.

```typescript
 // we explicitly state each Arbor class as syncing.
 // That allows to do some inheritance with abstract classes without polluting the global state
@syncing
class User extends ArborModel {
  // todo actually support override
  // modelName, that is used as a key in hydration flow, is automatically inferred from class name but can be overridden
  // this is done to make single-tree apps simple while making multi-tree apps possible
  // static modelName = "User"
  
  // any @syncing field gets synced  
  @syncing
  accessor name: string;

  // the only constraint you have is the types allowed to be synced. It can be any primitive value or any ArborModel.
  @syncing
  accessor email: string;
  
  // if you need maps, you have to use a bit different declaration
  @syncing.record
  accessor userAttributes: {
    // yes, you are allowed to mix primitives and ArborModels.
    // However, you are still limited to them. If you need complex type, you need to register it as another ArborModel
    inviter: User,
    registeredAt: string
  } 
  
  // same works with arrays
  @syncing.array
  accessor projects: Project[];
  
  // and even sets
  @syncing.set
  accessor featureFlags: Set<string>
  
  // you can just define anything you want. It's still JS classes. Just with some fields being synced
  get nickname() {
    return this.name || this.email.split('@')[0];
  }
}
```

From this perspective it's quite clear that it is actually looking like "MobX with replication".
You do not need to know anything new. Just add `@syncing` to make something syncing (ok, with few constraints coming from types not available from the runtime).

## World tree class

But the "world tree" concept is a bit more complex, adding new primitives to the whole structure.

First, any Arbor tree starts with root, that is defined in Arbor class:
```typescript
// Arbor class itself is abstract, so you need to do explicit declaration for implementation.
// We're syncing via yjs. Since yjs is highly flexible, it's basically your responsibility to decide how to make it work.
// This is done specifically to not limit the access to the initialization flow.
// One of reasons why Arbor class is abstract is to promote the document setup in child constructor.
class MyArbor extends Arbor<User> {
  constructor(projectId: string) {
    const doc = new Y.Doc();
    super(doc);
    // Set up sync provider of choice. at this point of time you are free to implement any logic over the doc
    this.syncProvider = {...};
    // this.rootPromise is represented in Arbor class already but you are free to overwrite it in constructor
    this.rootPromise = new Promise((res) => this.syncProvider.on("synced", res))
      // root loading is postpoined until state is synced
      .then(() => this.loadRoot());
  }
}

const arbor = new MyArbor('test project');
const user = await arbor.rootPromise;
```

When application starts with some root node (even the god object), it becomes dramatically way simpler to manage what's
happening inside the application.

Yes, arbor brings several easily mitigatable constraints, but in exchange it offers something amazing.

First, it allows to use single instances to represent any node:
```typescript
const arbor = new MyArbor('test project');
const user = await arbor.rootPromise;
user === arbor.loadEntity(user.uuid) // true. you do not need to check by uuid or in any other manner
```

By detaching the state tree from render tree, we are able to think with application, not render.
```typescript
@syncing
class User extends ArborModel {
  @syncing
  accessor name: string;

  @syncing
  accessor email: string;

  useStore = create((set) => ({...})) // zustand store 
  $counter = createStore(0); // effector store
  
  @observable
  accessor newName: string; // mobx
}
```

Since this is stored in a singleton representing the app, it is persistent - when you exit the component, it does not get destructed.
Of course, if you need some component grade state, you can do it - just outside the Arbor model. Simply because it's render state, not app state.

## Child management

In addition to common syncing fields, arbor also supports automatich parent-child relationship tracking

```typescript
@syncing
class Project extends ArborModel {
  @syncing.child.list
  accessor pages: Page[];
}
@syncing
class Page extends ArborModel {
  // TypeScript does not allow to dynamically detect child/parent relations, sadly, so we need to define that manually  
  declare parent: Project;
  
  @syncing
  accessor name: string;
}

const page1 = new Page({name: "page 1"});
const page2 = new Page({name: "page 2"});
const project1 = new Project({
  pages: [page1, page2]
})
const project2 = new Project({
  pages: [project1.pages[0]]
})
console.log(project1.pages) // new Page({name: "page 2"})
console.log(page1.parent) // project2
```

This works only with child fields; non-child fields will not use this logic.
value field, record field (`@syncing.child.record`), set field (`@syncing.child.set`), array field (
`@syncing.child.list`) are all supported in that flow.

Besides other benefits, this allows making the answer to the question "what to sync" dead simple.

> Anything that can be reached from Arbor root is expected to synced. Everything else is ephemeral.

