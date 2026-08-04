/**
 * Side-effect install: `awareness.reactive` + entity MobX tracking hooks.
 *
 *   import "@here.build/plexus-mobx-awareness/register";
 *
 * Separated from the class so constructing {@link ReactiveAwareness} never
 * mutates `PlexusAwareness.prototype` unless the host opts in.
 */

import { DefaultedWeakMap } from "@here.build/collections";
import { PlexusAwareness } from "@here.build/plexus";
import { enableMobXIntegration } from "@here.build/plexus/mobx";

import { ReactiveAwareness } from "./ReactiveAwareness.js";

enableMobXIntegration();

export const reactiveAwarenessOf = new DefaultedWeakMap(
  (awareness: PlexusAwareness) => new ReactiveAwareness(awareness),
);

export function reactive(awareness: PlexusAwareness): ReactiveAwareness {
  return reactiveAwarenessOf.get(awareness);
}

const proto = PlexusAwareness.prototype as PlexusAwareness & {
  reactive?: ReactiveAwareness;
};

if (!Object.prototype.hasOwnProperty.call(proto, "reactive")) {
  Object.defineProperty(proto, "reactive", {
    configurable: true,
    enumerable: false,
    get(this: PlexusAwareness): ReactiveAwareness {
      return reactive(this);
    },
  });
}

declare module "@here.build/plexus" {
  interface PlexusAwareness {
    readonly reactive: ReactiveAwareness;
  }
}
