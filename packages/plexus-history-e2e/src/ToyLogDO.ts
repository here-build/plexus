import { DurableObject } from "cloudflare:workers";
import {
  ancestorChain,
  changesBetween,
  InMemoryCutLog,
  valueAsOf,
  type Cut,
  type UserSession,
} from "@here.build/plexus-history";
import { deserializeCut, serializeCut, type JsonCut } from "@here.build/plexus-history/capture";
import { consolidate, humanize, type IntentEvent, type LensCtx } from "@here.build/plexus-history-lens";
import * as Y from "yjs";

import type { Env } from "./env.js";

interface Frame {
  seq: number;
  timestamp: number;
  author: UserSession | null;
  annotation: string;
  events: IntentEvent[];
}

/**
 * Toy archive + side-API. The gc:false replica of the project doc + a {@link InMemoryCutLog},
 * fed by the leader's co-flush (`applyDiffAndCuts`). `fetch` exposes two range-diff endpoints
 * of identical `?from=…&to=…` shape — a sketch for a future GitHub action.
 *
 * The annotation is now produced by the **describing layer** (`@here.build/plexus-history-lens`):
 * `PlexusChange[]` → `consolidate` → `IntentEvent[]` → `humanize`. The lens is here.build-model-specific;
 * the names it needs come from a product-supplied {@link lensCtx} (clay tenet — core stays domain-agnostic).
 *
 * In production this is the `extends ProjectLogDO` surface; durable DO-storage + R2 for the cut-log is the
 * server pass. Here the cut-log is in-memory (the DO lives for the test).
 */
export class ToyLogDO extends DurableObject<Env> {
  private readonly archive = new Y.Doc({ gc: false });
  private readonly cutLog = new InMemoryCutLog();

  /** Co-flush from the leader: the struct diff + the cuts grounded in those structs. */
  applyDiffAndCuts(diff: Uint8Array, jsonCuts: JsonCut[]): void {
    Y.applyUpdate(this.archive, diff);
    for (const jc of jsonCuts) this.cutLog.append(deserializeCut(jc));
  }

  /** Serialized cut-log (for the test to address ranges by SV / timestamp). */
  allCuts(): JsonCut[] {
    const head = this.cutLog.latest();
    return head ? this.cutLog.range(0, head.seq).map(serializeCut) : [];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const from = this.resolve(url.searchParams.get("from"));
    const to = this.resolve(url.searchParams.get("to"));
    if (!from || !to) {
      return Response.json({ error: "unresolved from/to", from: !!from, to: !!to }, { status: 400 });
    }
    if (url.pathname.endsWith("/cumulative")) {
      const events = this.cumulative(from, to);
      return Response.json({ from: from.seq, to: to.seq, annotation: humanize(events), events });
    }
    if (url.pathname.endsWith("/granular")) {
      return Response.json({ from: from.seq, to: to.seq, frames: this.granular(from, to) });
    }
    return new Response("not found", { status: 404 });
  }

  // ── range endpoints (the describing layer does the work) ─────────────────────

  /** Net intent events over the whole range. (Cross-cut net-collapse — rename→rename = one — is a lens TODO.) */
  private cumulative(from: Cut, to: Cut): IntentEvent[] {
    const changes = changesBetween(this.archive, from, to, this.cutLog.range(from.seq + 1, to.seq));
    return consolidate(changes, this.lensCtx());
  }

  /** Per-frame: one entry per cut in (from, to], each its own intent events + humanized annotation. */
  private granular(from: Cut, to: Cut): Frame[] {
    const frames: Frame[] = [];
    const ctx = this.lensCtx();
    let prev: Cut = from;
    for (const cut of this.cutLog.range(from.seq + 1, to.seq)) {
      const events = consolidate(changesBetween(this.archive, prev, cut, [cut]), ctx);
      frames.push({ seq: cut.seq, timestamp: cut.timestamp, author: cut.author, annotation: humanize(events), events });
      prev = cut;
    }
    return frames;
  }

  // ── the lens's model window (clay tenet: the PRODUCT resolves names from the model) ──

  private lensCtx(): LensCtx {
    const nameOf = (uuid: string, atSeq: number): string | undefined => {
      const cut = this.cutLog.get(atSeq);
      if (!cut) return undefined;
      const v = valueAsOf(this.archive, uuid, "name", cut, this.cutLog.range(0, atSeq));
      return typeof v === "string" ? v : undefined;
    };
    const ownerOf = (uuid: string, atSeq: number): string | undefined => {
      const cut = this.cutLog.get(atSeq);
      const chain = ancestorChain(this.archive, uuid, cut, cut ? this.cutLog.range(0, atSeq) : undefined);
      // chain[0] = self; the first component-typed ancestor owns it (a PageMeta's PageComponent).
      // NB: endsWith("Component") is a toy-grade heuristic (TplComponent would match too, but isn't an
      // ancestor of PageMeta) — the real lens keys off the model's own ownership types.
      return chain.slice(1).find((r) => r.type.endsWith("Component"))?.uuid;
    };
    return { nameOf, ownerOf };
  }

  // ── from/to parsing: HEAD / HEAD~n / seq / @ISO-datetime / base64 state-vector ─

  private resolve(s: string | null): Cut | undefined {
    if (!s) return undefined;
    if (s === "HEAD" || s.startsWith("HEAD~")) return this.cutLog.resolveRef(s as `HEAD~${number}`);
    if (/^\d+$/.test(s)) return this.cutLog.resolveRef(Number(s));
    if (s.includes("T") && !Number.isNaN(Date.parse(s))) return this.cutLog.resolveRef(`@${s}`);
    try {
      const entries = JSON.parse(atob(s)) as Array<[number, number]>;
      return this.matchBySv(new Map(entries));
    } catch {
      return undefined;
    }
  }

  /** A base64 state-vector addresses the cut whose afterState matches (else the latest ≤ it). */
  private matchBySv(sv: Map<number, number>): Cut | undefined {
    const head = this.cutLog.latest();
    if (!head) return undefined;
    const all = this.cutLog.range(0, head.seq);
    const eq = (a: Map<number, number>): boolean => a.size === sv.size && [...a].every(([k, v]) => sv.get(k) === v);
    return all.find((c) => eq(c.afterState)) ?? [...all].reverse().find((c) => [...c.afterState].every(([k, v]) => (sv.get(k) ?? -1) >= v));
  }
}
