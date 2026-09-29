# @here.build/plexus-vfs

Filesystem model over Plexus entities (`PlexusFS` / `PlexusDir` / `PlexusFile`)
with entity-path helpers. Suitable as an isomorphic-git `fs` backend.

```ts
import { PlexusFS } from "@here.build/plexus-vfs";
```

`@here.build/plexus` is a peer dependency (`workspace:^`, converted to a caret range for the workspace version when packed). The application and VFS must share one Plexus instance so model classes and document registries match.

Other peers are `lib0@^0.2.119`, `mobx@^6.16.1`, `yjs@^13.6.33`, and `isomorphic-git@^1.42.3`. The public declarations reference isomorphic-git's types, so it is required even when only using filesystem methods. `tslib@^2.8.1` is a runtime dependency installed automatically.

## License

[MIT](./LICENSE.md).
