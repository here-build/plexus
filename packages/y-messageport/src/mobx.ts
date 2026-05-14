/**
 * MobX reactivity for YMessagePortProvider — side-effect import.
 *
 *   import "@here.build/y-messageport/mobx";
 *
 * After importing once anywhere in the app, reading `provider.synced` or
 * `provider.status` inside a MobX reaction (`autorun`, `reaction`, observer
 * component) tracks the value and re-fires when it changes. Backed by
 * lib0/observable events (`sync`, `status`) — no polling.
 *
 * mobx is an optional peer-dep. Don't import this module unless you've
 * installed mobx. The subpath is intentionally side-effect-only so consumers
 * don't have to thread observability through their wiring.
 */

import { createAtom, type IAtom } from "mobx";

import { YMessagePortProvider } from "./YMessagePortProvider.js";

interface AtomPair {
  sync: IAtom;
  status: IAtom;
}

const atoms = new WeakMap<YMessagePortProvider, AtomPair>();

function pairFor(p: YMessagePortProvider): AtomPair {
  let pair = atoms.get(p);
  if (pair !== undefined) return pair;
  pair = {
    sync: createAtom("YMessagePortProvider.synced"),
    status: createAtom("YMessagePortProvider.status"),
  };
  atoms.set(p, pair);
  p.on("sync", () => pair!.sync.reportChanged());
  p.on("status", () => pair!.status.reportChanged());
  return pair;
}

const proto = YMessagePortProvider.prototype;
const origSynced = Object.getOwnPropertyDescriptor(proto, "synced");
const origStatus = Object.getOwnPropertyDescriptor(proto, "status");

if (!origSynced?.get || !origStatus?.get) {
  throw new Error("y-messageport/mobx: prototype getters missing (incompatible build)");
}

const getSynced = origSynced.get;
const getStatus = origStatus.get;

Object.defineProperty(proto, "synced", {
  configurable: true,
  get(this: YMessagePortProvider): boolean {
    pairFor(this).sync.reportObserved();
    return getSynced.call(this);
  },
});

Object.defineProperty(proto, "status", {
  configurable: true,
  get(this: YMessagePortProvider) {
    pairFor(this).status.reportObserved();
    return getStatus.call(this);
  },
});
