/**
 * Per-base MobX lens on a hub {@link ReactiveAwareness}.
 *
 * Field existence and values live here (not a parallel hub-only map) so
 * hub aggregates like `byField` compose by reading this face — one observation
 * graph for slice and scan.
 */

import { DefaultedMap } from "@here.build/collections";
import { ComputedMap } from "@here.build/collections/mobx";
import { PlexusAwareness } from "@here.build/plexus";
import { comparer, computed, createAtom, type IAtom } from "mobx";
import invariant from "tiny-invariant";

import type { ReactiveAwareness } from "./ReactiveAwareness.js";

export class ReactiveClientAwareness {
  readonly #presence: IAtom;
  readonly #schema: IAtom;
  readonly #fieldAtoms = new DefaultedMap((name: string) =>
    createAtom(`ReactiveClientAwareness:${this.clientId}:field:${name}`),
  );

  /**
   * Wire field semantics match {@link PlexusAwareness.getField}:
   * `undefined` = name never in schema, `null` = registered then cleared.
   *
   * Local bases can use `getField` (schema index is on this awareness instance).
   * Peers only expose a merged view via `getPeer` — channel packing is
   * `base + (schemaIndex+1) * CHANNEL_STRIDE` (channel 0 holds the schema).
   */
  readonly values = new ComputedMap<string, unknown | null | undefined>((name) => {
    invariant(!this.#disposed, "ReactiveClientAwareness: field value read after dispose");
    this.#fieldAtoms.get(name).reportObserved();

    const hub = this.parent.awareness;
    if (this.clientId === hub.clientID) {
      return hub.getField(name);
    }

    const schema = hub.states.get(this.clientId);
    if (!Array.isArray(schema)) return undefined;
    const idx = schema.indexOf(name);
    if (idx === -1) return undefined;

    const raw = hub.states.get(PlexusAwareness.channelId(this.clientId, idx + 1));
    if (raw === undefined || raw === null) return null;

    const peer = hub.getPeer(this.clientId);
    if (!peer || !(name in peer)) return null;
    return peer[name];
  });

  #disposed = false;

  constructor(
    readonly parent: ReactiveAwareness,
    readonly clientId: number,
  ) {
    this.#presence = createAtom(`ReactiveClientAwareness:${clientId}:presence`);
    this.#schema = createAtom(`ReactiveClientAwareness:${clientId}:schema`);
  }

  /** Channel 0 still on the map (base heartbeat / schema slot). */
  @computed
  get present(): boolean {
    invariant(!this.#disposed, "ReactiveClientAwareness: present read after dispose");
    this.#presence.reportObserved();
    if (this.clientId >= PlexusAwareness.CHANNEL_STRIDE) return false;
    return this.parent.awareness.states.get(this.clientId) != null;
  }

  /**
   * Schema names from channel 0 only.
   *
   * Schema is append-only on the wire: a cleared field stays named here with
   * value `null` in {@link values}. Existence ≠ non-null value.
   */
  @computed({ equals: comparer.shallow })
  get fields(): readonly string[] {
    invariant(!this.#disposed, "ReactiveClientAwareness: fields read after dispose");
    this.#schema.reportObserved();
    const schema = this.parent.awareness.states.get(this.clientId);
    if (!Array.isArray(schema)) return [];
    return schema.filter((n): n is string => typeof n === "string");
  }

  hasField(name: string): boolean {
    return this.fields.includes(name);
  }

  field(name: string): unknown | null | undefined {
    return this.values.get(name);
  }

  /**
   * Multi-channel invalidation: channel 0 is schema+presence; higher channels
   * are field values in schema order (1-based index into the channel-0 array).
   */
  bumpChannel(channel: number): void {
    if (this.#disposed) return;
    if (channel === 0) {
      this.#presence.reportChanged();
      this.#schema.reportChanged();
      return;
    }
    const schema = this.parent.awareness.states.get(this.clientId);
    if (!Array.isArray(schema)) return;
    const name = schema[channel - 1];
    if (typeof name === "string") {
      this.#fieldAtoms.get(name).reportChanged();
    }
  }

  /** Channel-0 gone: observers of any field on this base must re-read. */
  bumpAll(): void {
    if (this.#disposed) return;
    this.#presence.reportChanged();
    this.#schema.reportChanged();
    for (const atom of this.#fieldAtoms.values()) atom.reportChanged();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
  }
}
