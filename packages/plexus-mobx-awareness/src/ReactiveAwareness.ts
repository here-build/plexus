/**
 * MobX observation over a {@link PlexusAwareness} hub.
 *
 * Entity field tracking (`@here.build/plexus/mobx`) and this lens both mint
 * atoms against the host's single mobx peer — one `computed` can read
 * plexus-synced state and awareness without a bridge.
 *
 * Instance cache / `aw.reactive` are opt-in side effects in `./register.js`
 * so the core package stays free of prototype mutation.
 */

import { DefaultedMap } from "@here.build/collections";
import { ComputedMap } from "@here.build/collections/mobx";
import { PlexusAwareness } from "@here.build/plexus";
import { enableMobXIntegration } from "@here.build/plexus/mobx";
import { comparer, computed, createAtom, type IAtom } from "mobx";
import invariant from "tiny-invariant";

import { ReactiveClientAwareness } from "./ReactiveClientAwareness.js";

type ChangePayload = { added: number[]; updated: number[]; removed: number[] };

export class ReactiveAwareness {
  readonly #membership: IAtom = createAtom("ReactiveAwareness.membership");

  readonly clients = new DefaultedMap((clientId: number) => new ReactiveClientAwareness(this, clientId));

  /**
   * Aggregate projection of one field across present bases.
   *
   * Not a second store: each entry is `clients.get(id).field(name)`, so a
   * reaction on `byField` and one on a single client's field share the same
   * per-field atoms (and peer isolation still holds for unrelated bases).
   */
  readonly byField = new ComputedMap<string, ReadonlyMap<number, unknown | null>>((field) => {
    const out = new Map<number, unknown | null>();
    for (const id of this.clientIds) {
      const v = this.clients.get(id).field(field);
      if (v !== undefined) out.set(id, v);
    }
    return out;
  });

  readonly #onBump = (changes: ChangePayload): void => {
    if (this.#disposed) return;
    this.#membership.reportChanged();
    for (const raw of [...changes.added, ...changes.updated, ...changes.removed]) {
      const { base, channel } = PlexusAwareness.parseChannelId(raw);
      if (!this.clients.has(base)) continue;
      const client = this.clients.get(base);
      // Channel-0 removal drops the whole base (schema + every field channel).
      // Only then do we need to wake field atoms that may never get a per-channel remove.
      if (changes.removed.includes(raw) && channel === 0) {
        client.bumpAll();
      } else {
        client.bumpChannel(channel);
      }
    }
  };

  readonly #onDestroy = (): void => {
    this.dispose();
  };

  #disposed = false;

  constructor(public readonly awareness: PlexusAwareness) {
    enableMobXIntegration();

    // Secondaries share hub.states but only re-emit `update` on the hub
    // (not `change`) — see PlexusAwareness multi-client wire. Membership and
    // field atoms must listen to both.
    awareness.on("change", this.#onBump);
    awareness.on("update", this.#onBump);
    awareness.on("destroy", this.#onDestroy);
  }

  /**
   * Present bases on the shared states map.
   *
   * Keys with `cid >= CHANNEL_STRIDE` are field channels of some base, not
   * bases themselves. Channel 0 value is the schema array; null/missing means
   * the base is gone. Sorted so `comparer.shallow` on the array is stable
   * across equivalent membership.
   */
  @computed({ equals: comparer.shallow })
  get clientIds(): readonly number[] {
    invariant(!this.#disposed, "ReactiveAwareness: clientIds read after dispose");
    this.#membership.reportObserved();
    return [...this.awareness.states.keys()]
      .filter((cid) => cid < PlexusAwareness.CHANNEL_STRIDE && this.awareness.states.get(cid) != null)
      .toSorted((a, b) => a - b);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.awareness.off("change", this.#onBump);
    this.awareness.off("update", this.#onBump);
    this.awareness.off("destroy", this.#onDestroy);
    for (const lens of this.clients.values()) lens.dispose();
    this.clients.clear();
  }
}
