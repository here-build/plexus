/**
 * Run `fn` inside the entity's owning Plexus transaction when materialized.
 * Bare (doc-less) entities run `fn` directly (pre-materialization).
 */

import { docPlexus, type PlexusModel } from "@here.build/plexus";

export function transactEntity<T>(entity: PlexusModel, fn: () => T): T {
  const doc = entity.__doc__;
  const plexus = doc ? docPlexus.get(doc) : undefined;
  return plexus ? plexus.transact(fn) : fn();
}
