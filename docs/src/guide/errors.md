---
title: Errors
description: typed throws for ownership and storage violations
---

## Error Types

Plexus throws specific error types with detailed console logging for ownership violations:

<table>
<thead>
<tr>
<th>Error</th>
<th>When</th>
</tr>
</thead>
<tbody>
<tr>
<td>`PlexusSelfAdoptionError`</td>
<td>Entity tries to adopt itself</td>
</tr>
<tr>
<td>`PlexusCycleError`</td>
<td>Adoption would create a cycle in the ownership tree</td>
</tr>
<tr>
<td>`PlexusDependencyError`</td>
<td>Attempting to modify a dependency entity</td>
</tr>
<tr>
<td>`PlexusRootParentError`</td>
<td>Attempting to set a parent on the root entity</td>
</tr>
<tr>
<td>`PlexusDocMismatchError`</td>
<td>Adopting an entity already materialized in a *different* doc — entities never change docs</td>
</tr>
<tr>
<td>`PlexusDuplicateChildError`</td>
<td>Same child appears twice in a child array/set</td>
</tr>
<tr>
<td>`PlexusTypedArrayAliasError`</td>
<td>A typed-array member would hand back a live view onto the CRDT-tracked buffer (`subarray()`, `.buffer`) — take `.slice()` for a detached copy; mutate in place to sync</td>
</tr>
<tr>
<td>`PlexusUnstorableValueError`</td>
<td>Writing a value yjs cannot store to a synced field (function, symbol, `Map`/`Set`, class instance) — allowed: primitives, `Uint8Array`, plain JSON, model references</td>
</tr>
</tbody>
</table>
