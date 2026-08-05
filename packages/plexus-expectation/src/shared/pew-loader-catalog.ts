/**
 * Kernel-hub loader inventory: reactive plans scan + catalog pen.
 * Observation rides the ambient `awareness.reactive` lens.
 */

import type { PlexusAwareness } from "@here.build/plexus";
import { computed } from "mobx";

import {
  mintLocalNonZero,
  type CatalogPresenceStatus,
  type LoaderCapability,
  type LoaderHealth,
  type PEW,
  type PlanAvailability,
} from "./presence.js";

export class PEWLoaderCatalog {
  #catalogClient: PlexusAwareness | null = null;

  constructor(readonly pew: PEW) {}

  /** Kind → availability on the kernel hub (empty without kernel). */
  @computed
  get plans(): ReadonlyMap<string, PlanAvailability> {
    const hub = this.pew.awareness;
    if (!hub) return new Map();
    const reactive = hub.reactive;
    const map = new Map<string, PlanAvailability>();

    // Catalog role: loaders + capabilities records (kind-keyed).
    for (const id of reactive.clientIds) {
      const client = reactive.clients.get(id);
      if (client.field("role") !== "catalog") continue;
      const loaders = (client.field("loaders") ?? {}) as Readonly<Record<string, LoaderHealth>>;
      const capabilities = (client.field("capabilities") ?? {}) as Readonly<Record<string, LoaderCapability>>;
      for (const kind of new Set([...Object.keys(loaders), ...Object.keys(capabilities)])) {
        map.set(kind, {
          kind,
          health: loaders[kind] ?? "unadvertised",
          capability: capabilities[kind],
          source: "catalog",
        });
      }
      break;
    }

    // Loader self-records (escape hatch): capability wins, health stays catalog's.
    for (const id of reactive.clientIds) {
      const client = reactive.clients.get(id);
      if (client.field("role") !== "loader") continue;
      const kind = client.field("kind");
      if (typeof kind !== "string") continue;
      const selfCap = client.field("capability") as LoaderCapability | undefined;
      const existing = map.get(kind);
      if (existing) {
        map.set(kind, {
          kind,
          health: existing.health,
          capability: selfCap ?? existing.capability,
          source: selfCap === undefined ? existing.source : existing.source === "catalog" ? "both" : "loader",
        });
      } else if (selfCap !== undefined) {
        map.set(kind, { kind, health: "unadvertised", capability: selfCap, source: "loader" });
      }
    }
    return map;
  }

  plan(kind: string): PlanAvailability | undefined {
    return this.plans.get(kind);
  }

  /** Publish loaders + capabilities on the kernel hub (stable catalog client). */
  publish(status: CatalogPresenceStatus): void {
    const hub = this.pew.awareness;
    if (!hub) return;
    const client = this.#ensureClient(hub);
    client.setField("role", "catalog");
    client.setField("loaders", status.loaders as never);
    client.setField("capabilities", status.capabilities as never);
  }

  #ensureClient(hub: PlexusAwareness): PlexusAwareness {
    if (this.#catalogClient) return this.#catalogClient;
    // Kernel's own hub base may publish catalog fields in-place (no secondary mint).
    if (this.pew.kernel && hub === this.pew.kernel.awareness) {
      this.#catalogClient = hub;
      return hub;
    }
    this.#catalogClient = mintLocalNonZero(hub);
    return this.#catalogClient;
  }
}
