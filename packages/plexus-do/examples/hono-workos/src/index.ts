/**
 * Hono host + WorkOS identity + org-scoped rooms.
 *
 * Flow (same split as a production API Worker):
 *   1. Optional Cloudflare Access JWT (TEAM_DOMAIN set).
 *   2. WorkOS access token (Bearer, `?access_token=`, or `wos-access-token` cookie).
 *   3. Access control: `org_id === :docId`. The doc guid *is* the org.
 *   4. Strip inbound `x-internal-*`, stamp user + org, `idFromName` + `seed`, forward.
 *
 * Browsers cannot set Authorization on `new WebSocket` — use `?access_token=`.
 */

import { Hono } from "hono";
import * as Y from "yjs";

import { assertOrgOwnsDoc, requireAccess, stampInternal, verifyWorkos } from "./auth.js";
import { DocLeader } from "./doc-leader.js";
import type { Env } from "./env.js";

export { DocLeader };
export type { Env };

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const blocked = await requireAccess(c.req.raw, c.env);
  if (blocked) return blocked;
  return next();
});

app.all("/docs/:docId/ws", (c) => routeToLeader(c, "ws"));
app.get("/docs/:docId/snapshot", (c) => routeToLeader(c, "snapshot"));
app.post("/docs/:docId/seed", async (c) => {
  const gate = await admit(c);
  if (gate instanceof Response) return gate;
  const { stub, docId } = gate;
  const body = new Uint8Array(await c.req.raw.arrayBuffer());
  const bytes = body.byteLength > 0 ? body : Y.encodeStateAsUpdate(new Y.Doc());
  await stub.seed(docId, bytes);
  return new Response(null, { status: 204 });
});

app.notFound(() => new Response("usage: /docs/:docId{/ws|/snapshot|/seed}", { status: 404 }));

export default app;

async function routeToLeader(
  c: { req: { raw: Request; param(name: string): string }; env: Env },
  action: "ws" | "snapshot",
): Promise<Response> {
  const gate = await admit(c);
  if (gate instanceof Response) return gate;
  const { stub, stamped } = gate;
  await ensureNamed(stub, gate.docId);

  if (action === "ws") return stub.fetch(stamped);

  const inner = new URL(stamped.url);
  inner.pathname = "/snapshot";
  return stub.fetch(new Request(inner, stamped));
}

async function admit(c: { req: { raw: Request; param(name: string): string }; env: Env }) {
  const docId = c.req.param("docId");
  const session = await verifyWorkos(c.req.raw, c.env);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!assertOrgOwnsDoc(session, docId)) return new Response("org does not own this doc", { status: 403 });

  const stub = c.env.DOC_LEADER.get(c.env.DOC_LEADER.idFromName(docId));
  return { stub, docId, stamped: stampInternal(c.req.raw, session) };
}

async function ensureNamed(stub: DurableObjectStub<DocLeader>, docId: string): Promise<void> {
  const snap = await stub.getSnapshot();
  if (snap.byteLength > 2) return;
  await stub.seed(docId, snap.byteLength > 0 ? snap : Y.encodeStateAsUpdate(new Y.Doc()));
}
