/**
 * Control-plane message taxonomy.
 *
 * Carried as structured-clone JS objects (NOT lib0 varUint frames) because
 * control traffic is low-frequency and structured. Doc ports — allocated by
 * `ControlChannel.open()` — carry the bursty lib0-encoded y-protocols traffic.
 *
 * Wire shape (per direction):
 *   sender → peer.postMessage(controlMessage, transferList?)
 *
 * `open` is the one message that carries a MessagePort in the transfer list
 * (the peer-side end of a fresh MessageChannel allocated by the sender).
 *
 * See `docs/working-proposals/y-messageport-control-channel.md` for the
 * design rationale (cohort research 2026-05-14).
 */

export const PROTOCOL_VERSION = "y-control/1";

/**
 * Warmup priority tier. `low` = cheap unconditional preload (IDB hydrate,
 * snapshot fetch). `high` = metered work (WebSocket open + initial sync);
 * worker policy may gate `high` on focus + budget. Application-policy
 * vocabulary — ControlChannel just shuttles it.
 */
export type WarmupPriority = "low" | "high";

export type ControlMessage =
  | { kind: "hello"; proto: typeof PROTOCOL_VERSION }
  | { kind: "open"; id: string } // MessagePort accompanies in transfer list
  | { kind: "close"; id: string } // advisory — receiver decides what to do
  | { kind: "warmup"; id: string; priority: WarmupPriority } // preload hint, no port
  | { kind: "setFocus"; focused: boolean } // per-client window-focus signal
  | { kind: "ping"; nonce: number }
  | { kind: "pong"; nonce: number }
  | { kind: "status"; hop: string; status: string } // app-defined hop names
  | { kind: "error"; reason: string };

/**
 * Type guard. The wire is `unknown` — a hostile/buggy peer might post any JS
 * value. We accept the message only if it matches the discriminated-union
 * shape, otherwise the receiver emits an `error` event of kind
 * `wrong-payload-shape`.
 */
export function isControlMessage(value: unknown): value is ControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { kind?: unknown };
  switch (m.kind) {
    case "hello":
      return (value as { proto?: unknown }).proto === PROTOCOL_VERSION;
    case "open":
    case "close":
      return typeof (value as { id?: unknown }).id === "string";
    case "warmup": {
      const v = value as { id?: unknown; priority?: unknown };
      return (
        typeof v.id === "string" && (v.priority === "low" || v.priority === "high")
      );
    }
    case "setFocus":
      return typeof (value as { focused?: unknown }).focused === "boolean";
    case "ping":
    case "pong":
      return typeof (value as { nonce?: unknown }).nonce === "number";
    case "status": {
      const v = value as { hop?: unknown; status?: unknown };
      return typeof v.hop === "string" && typeof v.status === "string";
    }
    case "error":
      return typeof (value as { reason?: unknown }).reason === "string";
    default:
      return false;
  }
}
