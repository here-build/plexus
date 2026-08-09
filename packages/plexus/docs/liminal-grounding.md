# Liminal grounding — how shadow-primary realizes the liminal-state paper

**Status:** explanatory map. The paper (`(internal design notes)`)
describes a session-scoped shadow; the implementation runs shadow-primary. This document
names every place they diverge and states why each divergence computes the same algebra.
The algebra is the authority: CRDT operations commute, delta changesets add and subtract
safely, and clientId gives the known precedence order — so two realizations are "the
same" exactly when they produce the same op-log under the same register discipline.

## The registers (paper §A.3 — shared by both realizations)

```
[0, 2^51)         Regular    — normal operations        (p / b uuids)
[2^51, 2^52)      Liminal    — tentative session ops    (l uuids)
[2^52, 3×2^51)    Committed  — promoted commits         (never encoded; resolved
                                                          via the original l uuid)
[3×2^51, 2^53)    Genesis    — deterministic structure  (d uuids)
```

`committedId = liminalId + 2^51`. Resolution of an `l` uuid probes the committed
("bound") address first, then the liminal one — the paper's committed-preempts-tentative
precedence, expressed as a probe order (`deref.ts`).

## Divergence 1 — the shadow is the always-authoring surface

**Paper:** normal writes land on main; the shadow exists only during a session, sparing
peers the wire cost of ops that may be abandoned (§2.3).
**Code:** every write, session or not, lands on the shadow; entities are homed there
permanently (`Plexus.ts` root materialization on shadow).

**Why it is the same thing:** outside a session, every shadow transaction carries
`SHADOW_TO_MAIN` and is forwarded to prime **byte-identical, in the same tick, at the
same `(clientId, clock)` addresses** (`Plexus.ts` shadow→main listener). Algebraically
the steady-state shadow is an identity buffer in front of prime: the op-log prime
accumulates is indistinguishable from the paper's direct-to-main writes. The efficiency
grounding — one authoring surface, one materialization path, undo isolation — changes
where the pen sits, not what gets written. During a session the forwarder suppresses
`LIMINAL` origins, which is precisely the paper's "held on shadow".

## Divergence 2 — session boundaries restore, not reallocate

**Paper (A.4 commit, step 13):** `shadow.clientID ← limId + 1` — a fresh id after every
boundary, because in the session-scoped model the shadow's id IS a session id.
**Code:** commit/revert restore `__shadowRegularId__`, the shadow's resting
regular-register id; `enterLiminality` advances a strictly-increasing liminal sequence
(`X + LIMINAL_BASE + n`) instead.

**Why it is the same thing:** the paper's step 13 exists to prevent clock-gap reuse —
"main never saw the liminal clocks". Both properties survive translation: the liminal id
is never returned to (the next session takes `n+1` — paper invariant 1, strictly
increasing), and the resting id is gap-free by construction because main has seen every
one of its clocks via the same-tick forwarder. A.5 invariant 4 ("setup operations use
the regular clientId") holds in exactly the form the paper states it.

## Divergence 3 — three identity planes, not one clientId

**Paper:** speaks of "the peer's clientId" as one number per lifecycle stage.
**Code:** one peer holds three ids at once — prime's `doc.clientID` (sync-wire and
awareness identity; mints no entity structs), the shadow's resting id (steady-state
struct authorship), and the per-session liminal id (tentative struct authorship).

**Why it is the same thing:** the paper's precedence argument only needs authorship ids
to be register-partitioned and per-peer monotone within the liminal range — both hold.
The extra separation is forced by the substrate: Yjs rerolls a doc whose own clientID is
advanced by a non-local transaction, so prime and shadow can never share an id
(`yjs liminality research /two-doc.test.ts`, REJECTED APPROACHES). Awareness identity
riding prime's id is then free — presence and struct authorship never collide.

## Divergence 4 — preview transport writes into the receiver's shadow

**Paper (Appendix C):** previews reach the receiver's "tentative workspace".
**Code:** `applyPeerPreview` applies the base64 delta into the receiver's shadow under a
per-peer symbol origin that the forwarder blocks, with a per-peer UndoManager for
un-application.

**Why it is the same thing:** the tentative workspace IS the shadow in shadow-primary;
the forwarder's origin whitelist is what makes "tentative never reaches main" a
structural property instead of a discipline.

## History

The register discipline was dropped, not designed away: the single-doc→shadow-primary
migration (`ce3f8ef272`, 2026-03-28) carried the session-scratch shadow's born-liminal
clientId into its new permanent role, which made every entity mint `l` and left the `b`
binding unreachable. Restored 2026-08-05; the discipline is pinned by
`__tests__/8-liminality/register-discipline.test.ts` (born red against the drifted
state) and the reroll guard in
`__tests__/8-liminality/genesis-materialization-shadow-clientid.test.ts`.
