import type * as Y from "yjs";

/** Yjs state vector: clientID → next-expected clock (the insertion frontier). */
export type StateVector = Map<number, number>;

/** Per-frame delete-delta: clientID → ranges of deleted item clocks (Yjs DeleteSet shape). */
export type DeleteRanges = Map<number, Array<{ clock: number; len: number }>>;

/** Resolved actor identity. Stamped at capture (the session must be live to resolve it). */
export interface UserSession {
  userId: string;
  sessionId?: string;
  kind: "human" | "agent" | "cli" | "system";
}

/** Host-supplied hook: a writer's clientID → who they are. Backed e.g. by PeerAttributionTracker. */
export type ClientIdToUserSession = (clientId: number) => UserSession | null;

/**
 * A cut — one recorded transaction boundary. Carries the grounded-at-capture facts
 * the merged gc:false archive cannot reconstruct (time, author, per-frame deletions).
 * Addressed by monotonic `seq` (NOT the SV — pure deletes don't move the SV).
 */
export interface Cut {
  seq: number;
  timestamp: number;
  author: UserSession | null;
  afterState: StateVector;
  deletedRanges: DeleteRanges;
}

/** A reference to a Plexus entity. Plain JSON — the universal join key. */
export interface EntityRef {
  uuid: string;
  type: string;
  /** Human label, filled by `decorate(...)` via a product-supplied resolver. Never set by the lift. */
  label?: string;
}

export type Verb =
  | "materialized"
  | "set"
  | "clear"
  | "reparent"
  | "detach"
  | "insert"
  | "remove"
  | "reorder";

/**
 * A semantic, plain-JSON change — the public read boundary. Crosses an MCP/process
 * boundary (no `Y.Item`). Every change carries its own provenance (seq/timestamp/author),
 * stamped from the owning cut.
 */
export interface PlexusChange {
  seq: number;
  timestamp: number;
  author: UserSession | null;
  verb: Verb;
  entity: EntityRef;
  field?: string;
  /**
   * Entry key within a keyed collection (Y.Map / Plexus record): the CSS property, attribute name,
   * flag, role, etc. `field` names the collection; `key` names the entry. Absent for scalar attrs
   * (the attribute name rides in `field`) and positional Y.Array elements (no string key).
   */
  key?: string;
  before?: unknown;
  after?: unknown;
  from?: EntityRef;
  to?: EntityRef;
}

/** A single content-blind change located in the archive (INTERNAL — never public). */
export interface RawChange {
  kind: "insert" | "delete";
  id: { client: number; clock: number };
  item: Y.Item;
}

/**
 * Thrown by the differ when a cut references a struct missing from the archive —
 * the live-vs-cold lag, or a gc:true mistake. Loud, not a silent skip.
 */
export class MissingStructError extends Error {
  constructor(public readonly id: { client: number; clock: number }) {
    super(`plexus-history: struct ${id.client}:${id.clock} not found in archive (gc:true, or cut references un-flushed structs)`);
    this.name = "MissingStructError";
  }
}
