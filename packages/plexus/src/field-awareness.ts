/**
 * MobX lens over ONE awareness field — a lane.
 *
 * Atoms are minted per (field, clientId). A reaction reading one lane is not
 * woken by traffic on another lane, by another peer's cell, or by presence
 * heartbeats. That isolation is the point: awareness is one flat map on the
 * wire, so observing it wholesale re-runs every observer on every keystroke of
 * every peer.
 *
 * CHANGE ONLY. The heartbeat rewrites channel 0 with a deep-equal
 * schema every `outdatedTimeout / 2`, and `_writeChannel` routes deep-equal
 * rewrites to `update` alone (awareness.ts). Adding an `update` listener so
 * that "nothing is missed" wakes every lane of every peer twice a minute.
 *
 * A LANE IS THE MEMBERSHIP QUESTION. `clientIds` is who published THIS field,
 * not who is present; there is no per-client bag of properties to enumerate.
 * "Everyone who introduced themselves via `info`" is a lane, and asking it per
 * field is the whole vocabulary.
 *
 * NO SELF IN `getOthers()`. It answers "who ELSE published this" and skips the
 * local base deliberately; a caller wanting itself back composes it with
 * `get()`. `clientIds` and `getOther(id)` do NOT filter — `clientIds` lists
 * every base carrying the field, local one included.
 *
 * Reads are frozen deep, stopping at {@link PlexusModel}: a lens hands out a
 * snapshot of wire state, and a mutable one invites edits that never reach the
 * wire. Entity refs stay live because they are identities, not payload.
 */

import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import { createAtom, type IAtom, runInAction } from "mobx";

import { PlexusAwareness } from "./awareness.js";
import { PlexusModel } from "./PlexusModel.js";
import type { AwarenessShape } from "./proxy-runtime-types.js";

export type ShapeOfAwareness<A> = A extends PlexusAwareness<infer S> ? S : never;

/**
 * Deep-readonly awareness payload that stops at {@link PlexusModel}.
 * Entity refs stay live (identity + mutation). Plain objects/arrays do not.
 */
export type FrozenAwareness<T> = T extends PlexusModel
  ? T
  : T extends readonly (infer U)[]
    ? readonly FrozenAwareness<U>[]
    : T extends object
      ? { readonly [P in keyof T]: FrozenAwareness<T[P]> }
      : T;

type ChangePayload = { added: number[]; updated: number[]; removed: number[] };

type FieldAtoms = {
  readonly membership: IAtom;
  readonly cells: DefaultedMap<number, IAtom>;
};

type HubTrack = {
  readonly fields: DefaultedMap<string, FieldAtoms>;
};

const tracks = new DefaultedWeakMap<Map<number, unknown>, HubTrack>(() => ({
  fields: new DefaultedMap((name: string) => ({
    membership: createAtom(`FieldAwareness:${name}:membership`),
    cells: new DefaultedMap((id: number) => createAtom(`FieldAwareness:${name}:${id}`)),
  })),
}));

const wiredHubs = new WeakSet<PlexusAwareness>();

function wire(hub: PlexusAwareness): HubTrack {
  const track = tracks.get(hub.states);
  if (wiredHubs.has(hub)) return track;
  wiredHubs.add(hub);

  // see preamble, CHANGE ONLY
  const onChange = (changes: ChangePayload): void => {
    runInAction(() => {
      const seen = new Set<number>();
      for (const raw of [...changes.added, ...changes.updated, ...changes.removed]) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        const resolved = hub.fieldOfChannel(raw);
        if (!resolved) continue;
        if (resolved.field === null) {
          for (const atoms of track.fields.values()) {
            atoms.membership.reportChanged();
            // A departing peer's lane keys ride this same payload but resolve
            // to nothing: removal deletes their base's schema first, so
            // `fieldOfChannel` skipped them above. This branch is what wakes
            // their cells — deleting it as redundant strands every observer of
            // a peer that left.
            if (changes.removed.includes(raw) && atoms.cells.has(resolved.base)) {
              atoms.cells.get(resolved.base).reportChanged();
            }
          }
        } else if (track.fields.has(resolved.field)) {
          track.fields.get(resolved.field).cells.get(resolved.base).reportChanged();
        }
      }
    });
  };
  const onDestroy = (): void => {
    hub.off("change", onChange);
    hub.off("destroy", onDestroy);
    wiredHubs.delete(hub);
  };
  hub.on("change", onChange);
  hub.on("destroy", onDestroy);
  return track;
}

/** Structural half — `FrozenAwareness<T>` is conditional on an unresolved `T`,
 *  so the recursion runs untyped and the shape is asserted once at the boundary. */
function freezeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof PlexusModel) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeValue(item)));
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = freezeValue((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(copy);
}

function freezeAwarenessValue<T>(value: T): FrozenAwareness<T> {
  return freezeValue(value) as FrozenAwareness<T>;
}

export class FieldAwareness<
  A extends PlexusAwareness<AwarenessShape> = PlexusAwareness,
  K extends string & keyof ShapeOfAwareness<A> = string & keyof ShapeOfAwareness<A>,
> {
  readonly #field: FieldAtoms;

  constructor(
    readonly awareness: A,
    readonly name: K,
  ) {
    this.#field = wire(awareness).fields.get(name);
  }

  get(): FrozenAwareness<ShapeOfAwareness<A>[K]> | null | undefined {
    return this.getOther(this.awareness.clientID);
  }

  set(value: ShapeOfAwareness<A>[K]): void {
    this.awareness.setField(this.name, value);
  }

  clear(): void {
    this.awareness.clearField(this.name);
  }

  getOther(clientId: number): FrozenAwareness<ShapeOfAwareness<A>[K]> | null | undefined {
    this.#field.cells.get(clientId).reportObserved();
    const value = this.awareness.getField(this.name, clientId);
    if (value === undefined || value === null) return value;
    // `A` is constrained to `PlexusAwareness<AwarenessShape>`, so `getField` widens
    // to the whole value union; re-narrow to this lens's own field type.
    return freezeAwarenessValue(value) as FrozenAwareness<ShapeOfAwareness<A>[K]>;
  }

  getOthers(): ReadonlyMap<number, FrozenAwareness<ShapeOfAwareness<A>[K]> | null> {
    const out = new Map<number, FrozenAwareness<ShapeOfAwareness<A>[K]> | null>();
    for (const id of this.clientIds) {
      if (id === this.awareness.clientID) continue;
      const value = this.getOther(id);
      if (value !== undefined) out.set(id, value);
    }
    return out;
  }

  get clientIds(): readonly number[] {
    this.#field.membership.reportObserved();
    const ids = [this.awareness.clientID, ...this.awareness.getPeerIds()].filter(
      (id) => this.awareness.getField(this.name, id) !== undefined,
    );
    ids.sort((a, b) => a - b);
    return ids;
  }
}
