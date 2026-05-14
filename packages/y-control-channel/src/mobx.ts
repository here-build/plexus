/**
 * MobX reactivity for ControlChannel — side-effect import.
 *
 *   import "@here.build/y-control-channel/mobx";
 *
 * After importing once, reading `channel.lastSeenMs` inside a MobX reaction
 * tracks the value and re-fires whenever any inbound control message arrives.
 * Backed by listening to every event lib0/observable emits on the channel.
 *
 * mobx is an optional peer-dep.
 */

import { createAtom, type IAtom } from "mobx";

import { ControlChannel } from "./ControlChannel.js";

const atoms = new WeakMap<ControlChannel, IAtom>();

const TRACKED_EVENTS = ["hello", "open", "close", "status", "ping", "pong"] as const;

function atomFor(c: ControlChannel): IAtom {
  let atom = atoms.get(c);
  if (atom !== undefined) return atom;
  atom = createAtom("ControlChannel.lastSeenMs");
  atoms.set(c, atom);
  for (const ev of TRACKED_EVENTS) {
    c.on(ev, () => atom!.reportChanged());
  }
  return atom;
}

const proto = ControlChannel.prototype;
const origLastSeen = Object.getOwnPropertyDescriptor(proto, "lastSeenMs");

if (!origLastSeen?.get) {
  throw new Error("y-control-channel/mobx: prototype getter missing (incompatible build)");
}

const getLastSeen = origLastSeen.get;

Object.defineProperty(proto, "lastSeenMs", {
  configurable: true,
  get(this: ControlChannel): number {
    atomFor(this).reportObserved();
    return getLastSeen.call(this);
  },
});
