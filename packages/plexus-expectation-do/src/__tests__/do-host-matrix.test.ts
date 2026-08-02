/**
 * DO host matrix — RED-TEST FRONTIER (proposal §10, one describe per row).
 *
 * A row still marked `it.fails` carries the REAL eventual assertion, written
 * against the intended surface; today it throws (or fails an assertion) at
 * the first stub call, so that row stays red-by-design while CI stays green.
 * The moment implementation makes a body pass, vitest reports "expected to
 * fail but passed" — the marker MUST then be removed, so the frontier tracks
 * itself. Do not "fix" a failing body by weakening it; fix the implementation.
 * Stage 1 flipped the §3 gate, hibernate-as-orphan, and alarm-wake rows;
 * Stage 2 flips spawn retention, cancel-vs-settlement, and orphan actor DO;
 * Stage 3 flips declare-port one-writer and adds the presence-hub row (§8 —
 * not in the original matrix, an addition per the same finding, G10).
 *
 * Two rows cannot be expressed against fakes and live elsewhere:
 *  - real output-gate visibility + real eviction → workerd pool tests, added
 *    with the implementation (vitest-pool-workers, as in inhuman/saas/api);
 *  - dual-write journal repair (G11) → inhuman/saas/api (product-side seam).
 *
 * Findings referenced (G* = grok-4.5, LC* = LongCat-2.0) are recorded in the
 * proposal's §12 review record.
 */
import { describe, expect, it } from "vitest";

import { type ActorDoNamespacePort, deriveActorDoName, installKernel, type RelayFrame } from "../index.js";
import { DoTestExpectation, freshDoHost, flushMicrotasks, type DeclaringDoActor } from "./_helpers/do-test-host.js";

// --- the matrix ------------------------------------------------------------

describe("§3 gate / RUNNING-FIRST (G1, LC1)", () => {
  it("kill between running-commit and spawn: restart yields exactly one execution", async () => {
    const host = freshDoHost();
    const kernel = installKernel(host.opts);
    // Declare + drive activation up to the running write, then simulate isolate
    // death by discarding the kernel WITHOUT dispose. Storage (the fake) survives.
    // The actor never settles (no script) — the entity is stranded `running`,
    // exactly the shape a real crash between running-commit and dispose leaves.
    host.declare();
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running` synchronously from there
    const runningWrites = host.storage.log.filter((w) => String(w.key).includes("running"));
    expect(runningWrites.length).toBeGreaterThan(0);
    // Reborn kernel over the SAME storage+doc: reconcile must claim-orphan the
    // stranded running entity (failed/supervision), never spawn it a second time.
    const reborn = installKernel(host.opts);
    reborn.reconcile();
    const spawns = host.storage.log.filter((w) => String(w.key).includes("processorClientId"));
    expect(spawns.length).toBe(1);
  });

  it("terminal fold committed to storage before any observable effect survives restart", async () => {
    const host = freshDoHost();
    const kernel = installKernel(host.opts);
    // A self-completing actor: running → sealed in one kernel lifetime, so the
    // terminal fold's storage mirror is exercised without needing a restart.
    host.declare((actor) => actor.doComplete({ value: "ok" }));
    kernel.reconcile();
    await flushMicrotasks(); // load handshake + activation reaches `running`, spawns the actor
    await flushMicrotasks(); // settlement promise resolves; the fold commits the terminal
    // After a terminal fold, the terminal record must be in storage in the same
    // turn — a reborn kernel must see the terminal, not re-activatable work.
    const terminals = host.storage.log.filter((w) => String(w.key).includes("terminal"));
    expect(terminals.length).toBeGreaterThan(0);
  });
});

describe("spawn retention (G2)", () => {
  it("actor invocation promise is rooted via waitUntil in the same synchronous turn as spawn", async () => {
    let capturedOnFrame: ((frame: RelayFrame) => void) | undefined;
    const relayNs: ActorDoNamespacePort = {
      invoke: (_doName, _request, onFrame) => {
        capturedOnFrame = onFrame;
        return new Promise(() => {}); // never settles — retention must still hold it
      },
      terminate: async () => {},
    };
    const host = freshDoHost(relayNs);
    const kernel = installKernel(host.opts);
    host.declareRelay();
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running` synchronously from there, spawning the relay

    // The loader's sync spawn must hand the invocation promise to waitUntil in
    // the same turn — an unretained promise is cancellable on Workers once
    // the activation handler returns.
    expect(host.retained.length).toBeGreaterThan(0);
    expect(capturedOnFrame).toBeDefined();
  });
});

describe("cancel vs settlement, same tick (G7, LC4)", () => {
  it("settlement frame decoded in the cancel turn still seals with product fields", async () => {
    let deliver: ((frame: RelayFrame) => void) | undefined;
    const relayNs: ActorDoNamespacePort = {
      invoke: (_doName, _request, onFrame) => {
        deliver = onFrame;
        return new Promise(() => {}); // the transport channel itself stays open until abort tears it down
      },
      terminate: async () => {},
    };
    const host = freshDoHost(relayNs);
    const kernel = installKernel(host.opts);
    const e = host.declareRelay();
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running`, spawns the relay
    expect(deliver).toBeDefined();

    // Same synchronous turn, no `await` between them: an inbound settlement
    // frame decodes into the handle buffer FIRST, then a lease-dispose fold
    // (a cancel trigger, design.md §7 "same at lease dispose") runs against
    // the same entity. Relay buffer law (G7/LC4): the fold's
    // settlement-preference read must see the just-buffered settlement.
    deliver!({ kind: "settle", settlement: { outcome: "complete", result: { value: "relay-ok" } } });
    void kernel.dispose(); // disposeLease's fold body runs synchronously — no `await` precedes it

    expect(e.state).toBe("sealed");
    expect(e.endCause).toBe("settled");
    const sealed = host.storage.log.filter((w) => String(w.value).includes("sealed"));
    expect(sealed.length).toBe(1);
    const cancelled = host.storage.log.filter((w) => String(w.value).includes("cancelled"));
    expect(cancelled.length).toBe(0);
  });
});

describe("orphan actor DO (G4, G12, LC5)", () => {
  it("actor-DO name derives deterministically from the Expectation uuid", () => {
    const uuid = "0000-test-uuid";
    expect(deriveActorDoName(uuid)).toBe(deriveActorDoName(uuid));
  });

  it("reborn kernel terminates the recorded actor stub; ledger keys once per E uuid", async () => {
    const terminated: string[] = [];
    const relayNs: ActorDoNamespacePort = {
      invoke: () => new Promise(() => {}), // the actor DO never itself reports back in this scenario
      terminate: async (name) => {
        terminated.push(name);
      },
    };
    const host = freshDoHost(relayNs);
    const kernel = installKernel(host.opts);
    host.declareRelay();
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running`, actor-DO name recorded durably alongside processorClientId

    const actorDoNames = host.storage.log.filter((w) => String(w.key).includes("actorDoName"));
    expect(actorDoNames.length).toBe(1);
    expect(terminated.length).toBe(0); // still running — nothing to sweep yet

    // Kill the kernel WITHOUT dispose (simulated crash/eviction) and
    // reinstall over the SAME storage+doc: reconcile must first claim-orphan
    // the stranded `running` entity (no local handle survives eviction),
    // then — in that SAME sweep — terminate the recorded actor-DO stub.
    // Self-termination is never the only line of defense (proposal §5).
    const reborn = installKernel(host.opts);
    reborn.reconcile();
    expect(terminated.length).toBe(1);

    // Idempotent: a second sweep (this lifetime, or a further restart) must
    // not double-terminate.
    reborn.reconcile();
    expect(terminated.length).toBe(1);
  });
});

describe("hibernate-as-orphan (G3)", () => {
  it("evicted kernel + running work → claim-orphan failed(supervision), product-visible", async () => {
    const host = freshDoHost();
    host.declare(); // no script — hangs `running`, never settles
    const kernel = installKernel(host.opts);
    kernel.reconcile();
    await flushMicrotasks(); // first life: work reaches running
    const reborn = installKernel(host.opts); // eviction: process plane wiped, doc survives
    reborn.reconcile();
    const failed = host.storage.log.filter(
      (w) => String(w.value).includes("failed") && String(w.value).includes("supervision"),
    );
    expect(failed.length).toBe(1);
  });
});

describe("alarm wake (G14; rejects LC7)", () => {
  it("a fired alarm reaches reconcile and activates declared work", async () => {
    const host = freshDoHost();
    const kernel = installKernel(host.opts);
    // Alarms persist and wake evicted DOs (platform contract); the adapter must
    // (a) set an alarm on every envelope write and (b) route firing → reconcile.
    expect(host.alarms.setAt.length).toBeGreaterThan(0);

    // Warm the loader for this kind via a throwaway declaration so the
    // alarm-fired reconcile below activates the TARGET entity purely
    // synchronously (design.md §9: only a kind's FIRST activation pays the
    // async load cost — every later one is synchronous). Without this, the
    // fire()-driven reconcile would only kick off `loading` and the running
    // write would land on a microtask this synchronous test never awaits.
    host.declare((actor) => actor.doComplete({}));
    kernel.reconcile();
    await flushMicrotasks();

    host.declare(); // the work under test — declared, not yet activated
    host.alarms.fire();
    const running = host.storage.log.filter((w) => String(w.value).includes("running"));
    expect(running.length).toBeGreaterThan(0);
  });
});

describe("declare-port one-writer (G15/G16)", () => {
  it("actor's declare request produces a HOST-authored child; the actor holds no durable pen", async () => {
    const host = freshDoHost();
    const kernel = installKernel(host.opts);

    // The port is handed to in-process actors via `LaunchContext` (`InProcessLoader`,
    // proposal §7): requesting a child returns its uuid, and the mint
    // transaction is authored by the host identity (`DoOrchestrator#mintDeclaredChild`),
    // never by the actor.
    let declareSurfaceKeys: string[] | undefined;
    let childUuid: string | undefined;
    // The parent actor intentionally does NOT complete: design.md's tree-scoped
    // fold cascades-cancels every still-open descendant when its own subtree's
    // root settles (leaves-first, "orphans are cancelled by reconcile, never
    // re-executed") — completing here would immediately cancel the freshly
    // minted, not-yet-activated child before this test can observe its
    // `declared` state. A hanging parent (like every other `declare()` row
    // that never scripts a completion) keeps the child open to inspect.
    const parent = host.declareDeclaring((_actor, ctx) => {
      // (c) the actor's reachable surface exposes no durable write path — the
      // port object exposes only `declare`, nothing that reaches storage, the
      // doc, or the parent entity.
      declareSurfaceKeys = Object.keys(ctx.declare);
      childUuid = ctx.declare.declare(DoTestExpectation.kind, { payload: "declared-child" });
    });
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running`, spawns the actor, which calls declare() synchronously inside run()

    expect(declareSurfaceKeys).toEqual(["declare"]);
    expect(typeof childUuid).toBe("string");

    // (a) the mint appears in storage as a `declared` envelope write, keyed by
    // the CHILD's own uuid — authored by the host, not the actor.
    const mints = host.storage.log.filter(
      (w) => String(w.key).includes("declared") && String(w.key).includes(childUuid!),
    );
    expect(mints.length).toBe(1);

    // (b) the returned uuid identifies a REAL child Expectation, homed under
    // the requesting parent in the session doc — reachable transitively from
    // the open-work roots for free (work-roots law), since the parent already
    // was.
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]!.uuid).toBe(childUuid);
    expect(parent.children[0]!.state).toBe("declared");
  });
});

describe("presence hub topology (G10, proposal §8 — addition, not in the original matrix)", () => {
  it("mints exactly one client per spawn, before the processorClientId write; destroys it at fold", async () => {
    const host = freshDoHost();
    const kernel = installKernel(host.opts);

    // The actor intentionally does NOT complete synchronously: `doComplete`
    // buffers settlement synchronously, and — since it would already be
    // resolved before `handle.settled.then(fold)` is even attached — the fold
    // runs within the SAME `flushMicrotasks()` window as activation, leaving
    // no window to observe "minted but not yet destroyed". Capturing the
    // actor and completing it explicitly, later, creates that window.
    let capturedActor: DeclaringDoActor | undefined;
    const entity = host.declareDeclaring((actor) => {
      capturedActor = actor;
    });
    kernel.reconcile();
    await flushMicrotasks(); // load handshake completes; activation reaches `running`, spawns the actor — mints its presence client synchronously, before spawn returns

    // Exactly one client minted for this one spawn (PresencePort's "at most
    // one client per spawn" discipline, mirrored from core's own
    // `#mintPresencePort`).
    expect(host.presenceMints.length).toBe(1);
    const mintedClientId = host.presenceMints[0]!;
    expect(mintedClientId).not.toBe(0); // 0 is the no-presence sentinel — never resolved, never minted for a real actor

    // The clientID was obtained BEFORE the kernel's `processorClientId` write:
    // proven by data dependency, not just timing — the envelope mirror can
    // only carry the minted value if the mint already happened when the
    // kernel read `handle.clientId`.
    const processorWrites = host.storage.log.filter((w) => String(w.key).includes("processorClientId"));
    expect(processorWrites.length).toBe(1);
    const envelope = JSON.parse(String(processorWrites[0]!.value)) as { readonly processorClientId: number };
    expect(envelope.processorClientId).toBe(mintedClientId);
    expect(entity.processorClientId).toBe(mintedClientId);

    // Not yet destroyed — the actor hasn't settled.
    expect(host.presenceDestroyed.length).toBe(0);

    capturedActor!.doComplete({});
    await flushMicrotasks(); // settlement promise resolves; the fold aborts the actor's AbortController, which destroys the presence client
    expect(host.presenceDestroyed).toEqual([mintedClientId]);
  });
});
