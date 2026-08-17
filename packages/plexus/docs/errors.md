## Error Types

Plexus throws specific error types with detailed console logging for ownership violations:

| Error                        | When                                                                                                                                      |
|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `PlexusSelfAdoptionError`    | Entity tries to adopt itself                                                                                                              |
| `PlexusCycleError`           | Adoption would create a cycle in the ownership tree                                                                                       |
| `PlexusDependencyError`      | Attempting to modify a dependency entity                                                                                                  |
| `PlexusRootParentError`      | Attempting to set a parent on the root entity                                                                                             |
| `PlexusDocMismatchError`     | Adopting an entity already materialized in a *different* doc — entities never change docs                                                |
| `PlexusDuplicateChildError`  | Same child appears twice in a child array/set                                                                                             |
| `PlexusTypedArrayAliasError` | A typed-array member would hand back a live view onto the CRDT-tracked buffer (`subarray()`, `.buffer`) — take `.slice()` for a detached copy; mutate in place to sync |
| `PlexusUnstorableValueError` | Writing a value yjs cannot store to a synced field (function, symbol, `Map`/`Set`, class instance) — allowed: primitives, `Uint8Array`, plain JSON, model references |
