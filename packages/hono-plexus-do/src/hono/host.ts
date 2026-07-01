/**
 * Hono host wiring for DO-local HTTP routes.
 *
 * Durable Object `fetch` handlers often delegate non-WebSocket traffic to a
 * Hono app. Route modules should not import the DO class — they read the live
 * instance from context instead. `mountDocHost` binds `host` once per request
 * so handlers stay product-agnostic (`c.var.host.getSnapshot()`, etc.).
 *
 * Pattern from `buildProjectCollaborationApp` in here.build: the DO constructs
 * the app, calls `mountDocHost(app, this)`, and returns `app.fetch(request)`.
 */

import type { Hono } from "hono";

/** Attach the DO instance to `c.var.host` for every request on `app`. */
export function mountDocHost<Host, E extends { Variables: { host: Host } }>(app: Hono<E>, host: Host): Hono<E> {
  app.use("*", async (c, next) => {
    c.set("host", host);
    await next();
  });
  return app;
}