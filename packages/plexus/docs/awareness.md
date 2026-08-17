## Awareness (Presence)

`PlexusAwareness` is a multi-channel presence protocol on top of `y-protocols/awareness` with
the **same wire format**, so it works with existing providers (y-websocket, y-webrtc, …)
unchanged. Serialization format is richer than ordinary JSON; Plexus models can be used as fields or field parts.

```typescript
import { PlexusAwareness } from "@here.build/plexus";

type Presence = { cursor: { x: number; y: number }; name: string };

const awareness = new PlexusAwareness<Presence>(plexus.doc);
awareness.setField("name", "User");                 // broadcast once, then sleeps
awareness.setField("cursor", { canvas: new Canvas(), x: 10, y: 20 });  // only the cursor channel updates
awareness.getField("cursor");
awareness.clearField("cursor");

awareness.getPeerIds();     // base clientIds of live peers
awareness.getPeer(peerId);  // assembled Partial<Presence> for one peer
```

The wire codecs (`encodeAwarenessUpdate`, `applyAwarenessUpdate`,
`removeAwarenessStates`, `modifyAwarenessUpdate`) are exported for provider integration.

PlexusAwareness is non-reactive lower-level API that is y-protocols compatible.
For high-level reactive API, use `FieldAwareness`. 

### Reading a field reactively

`FieldAwareness` is a MobX lens over **one** field. Atoms are per (field, peer), so a reaction
reading one lane is never woken by traffic on another lane, by another peer's cell, or by a
heartbeat — which is the whole point, since awareness is one flat map on the wire and observing
it wholesale re-runs every observer on every keystroke of every peer.

```typescript
import { FieldAwareness } from "@here.build/plexus";

const cursors = new FieldAwareness(awareness, "cursor");

cursors.set({ x: 10, y: 20 });   // writes the local lane
cursors.clear();                  // retracts it
cursors.get();                    // own value
cursors.getOther(peerId);         // one peer's value
cursors.getOthers();              // Map<clientId, value> — excludes self
cursors.clientIds;                // every base publishing "cursor", self included
```

A lane answers membership per field, not per peer: *"everyone who introduced themselves via
`info`"* is a lane, and asking it field by field is the entire vocabulary — there is no
bag-of-properties to enumerate by design. `getOthers()` skips the local base deliberately; compose it with
`get()` when you want yourself back.

Reads are frozen. A lens hands out a snapshot of wire state, and a mutable one invites edits that
never reach the wire. The freeze stops at `PlexusModel` — entity references stay live.
