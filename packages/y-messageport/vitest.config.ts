/**
 * Default `pnpm test` for y-messageport — CI baseline runs in Node using the
 * platform `MessageChannel` (worker_threads). No browser involved here; this
 * suite validates the wire protocol and the Y.Doc ↔ MessagePort wiring purely
 * as a transport-level contract.
 *
 * Cross-browser cross-product scenarios (DedicatedWorker, SharedWorker,
 * ServiceWorker, cross-domain iframe, frame↔SW↔frame, IndexedDB-backed
 * worker, etc.) live in `src/__visual__/` and run via Playwright through
 * `pnpm visual`. They are NOT part of the default CI gate.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
