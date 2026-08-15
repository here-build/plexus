import { PlexusModel } from "@here.build/plexus";
import { docPlexus } from "@here.build/plexus/internals";

/** Run `fn` inside the owning doc's transaction (atomic multi-step ops). */
export function transact<T>(node: PlexusModel, fn: () => T): T {
  const doc = node.__doc__;
  const plexus = doc ? docPlexus.get(doc) : undefined;
  return plexus ? plexus.transact(fn) : fn();
}
