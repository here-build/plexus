/**
 * Live progress types — generator face of PEW.
 *
 * In-motion state lives on **per-Expectation awareness clients**
 * (one base clientId per open invocation), not on CRDT and not as a
 * Progress entity. See {@link Expectation.attachLivePresence}.
 */

/** Opaque progressive yield — product interprets. */
export type ProgressPatch = unknown;

/** How writes coalesce on the live client (also on LaunchDefinition.progressMode). */
export type ProgressMode = "lww" | "append" | "none";

/** Fixed field name on each Expectation's awareness client. */
export const PROGRESS_FIELD = "progress" as const;
