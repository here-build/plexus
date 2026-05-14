# Cross-browser matrix (Playwright)

This directory holds the cross-browser, cross-topology test matrix for `y-messageport`. **Not part of the default CI gate** — runs via `pnpm visual` and needs `pnpm exec playwright install`.

## Why this lives in `__visual__/`

Per `.claude/rules/tests.md`: any test that imports Playwright belongs in `__visual__/`, even when its output is pass/fail rather than pixels. Default CI runs in a minimal container without browsers — visual tests are opt-in.

## Matrix shape

Three independent axes — full cross-product, populated as `describe.each` / `it.each`:

| Axis           | Values                                                                 |
|----------------|------------------------------------------------------------------------|
| Transport host | DedicatedWorker · SharedWorker · ServiceWorker · top-frame · cross-domain iframe |
| Worker role    | wraps upstream y-websocket · hosts Y.Doc locally · persists Y.Doc to IndexedDB/OPFS |
| Topology       | window ↔ worker · top-frame ↔ cross-domain iframe · window ↔ worker ↔ cross-domain iframe · frame1 ↔ SharedWorker ↔ frame2 |

Browsers: chromium, firefox, webkit (Playwright `projects`).

Each scenario is validated against a real y-websocket relay (`harness/y-websocket-relay.ts`) so propagation is observable end-to-end, not faked.

## What is expected to break first

We deliberately do **not** preempt known foot-guns. Catching the empirical failure mode is the point — once we see the actual error, we know whether to fix the provider, document the limit, or work around the browser.

Predicted (from research, 2026-05):

- **ServiceWorker scenarios**: 30s idle kill kills the SW between Yjs bursts; the held MessagePort dangles. Expect timeouts on any test that pauses > 30s.
- **Chrome Android < 148 stable**: no `SharedWorker` constructor — those scenarios `ReferenceError` on test setup. Surface as a skip, not a failure, once detected.
- **Mixed `localhost` / `127.0.0.1` origins**: SharedWorker `SecurityError` at attach time.
- **WebKit headless**: leads shipped Safari by 3–6 months; some failures may not reflect real user impact.

## File layout (target)

```
__visual__/
├── playwright.config.ts          # 3 browsers × ephemeral ports + harness webServer
├── harness/
│   ├── http-server.ts            # serves two origins (top + cross-domain iframe port)
│   ├── y-websocket-relay.ts      # real y-websocket server on ephemeral port
│   ├── browser/
│   │   ├── top-frame.html
│   │   ├── iframe.html           # served on second origin
│   │   ├── dedicated-worker.ts
│   │   ├── shared-worker.ts
│   │   └── service-worker.ts
│   └── boot.ts                   # browser-side wiring (Y.Doc + provider + assertion hooks)
└── scenarios/
    ├── window-dedicated-worker.test.ts   # window ↔ DedicatedWorker
    ├── window-shared-worker.test.ts      # window ↔ SharedWorker
    ├── window-service-worker.test.ts     # window ↔ ServiceWorker (expected: fragile)
    ├── top-iframe.test.ts                # top-frame ↔ cross-domain iframe
    ├── window-worker-iframe.test.ts      # window ↔ worker ↔ cross-domain iframe
    └── frame-sharedworker-frame.test.ts  # frame1 ↔ SharedWorker ↔ frame2
```

Use nested `describe.each([...browsers]) > describe.each([...workerRoles]) > it("propagates ...")` so the full cross-product appears in test output.

## Current status

**Scaffolded, not populated.** The transport itself (`src/protocol.ts` + `src/YMessagePortProvider.ts`) is covered by the Node-MessageChannel baseline at `src/__tests__/`. The browser matrix is the next chunk of work — each cell of the matrix needs its own browser entrypoint script and harness wiring; not a single-commit job.
