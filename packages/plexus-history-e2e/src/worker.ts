import type { Env } from "./env.js";

export { ToyProjectDO } from "./ToyProjectDO.js";
export { ToyLogDO } from "./ToyLogDO.js";

// Trivial default handler — the e2e drives the DOs directly via `env` stubs (cloudflare:test).
export default {
  fetch(_request: Request, _env: Env): Response {
    return new Response("plexus-history-e2e toy worker", { status: 200 });
  },
};
