/**
 * Membrane / model performance benchmarks (CI ladder: 1k / 4k / 16k).
 * Design: docs/working-proposals/plexustext-perf-stress-tests.md
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  alpha,
  assertAtMostLinear,
  connectPeer,
  plain,
  summarizeTimes,
  syncAtoB,
  withCounterWindow,
} from "../bench/index.js";
import { insertTextAt, textDiffs, toText } from "../marker.js";

const SIZES = [1_000, 4_000, 16_000] as const;

function drain(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

describe("plexus-text bench — model scaling (W1 remote 1-char insert)", () => {
  it("reports size vector + seed cost, and measures remote insert observe+apply counters", async () => {
    const rows: Array<{
      N_chars: number;
      N_nodes: number;
      seed_ms: number;
      bytes_state: number;
      t_mutate_p50: number;
      t_transport_p50: number;
      t_total_p50: number;
      nodesScanned_med: number;
      toText_med: number;
      replaceSpan: number;
    }> = [];

    for (const N of SIZES) {
      const A = plain(N);
      const B = connectPeer(A.doc);

      // Warmup
      for (let i = 0; i < 5; i++) {
        insertTextAt(A.root, N + i, "x");
        syncAtoB(A.doc, B.doc);
      }

      const mutateSamples: number[] = [];
      const transportSamples: number[] = [];
      const totalSamples: number[] = [];
      const nodesScannedSamples: number[] = [];
      const toTextSamples: number[] = [];
      let lastReplaceSpan = 0;

      const measured = 40;
      for (let i = 0; i < measured; i++) {
        const beforeB = toText(B.root);
        const offset = Math.floor(N / 2);

        const t0 = performance.now();
        const { delta } = withCounterWindow(() => {
          insertTextAt(A.root, offset, "Z");
        });
        const t1 = performance.now();
        mutateSamples.push(t1 - t0);

        const update = Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc));
        const t2 = performance.now();
        Y.applyUpdate(B.doc, update);
        const t3 = performance.now();
        transportSamples.push(t3 - t2);

        await drain();
        const afterB = toText(B.root);
        // Approximate "replace span" of textDiff(beforeB, afterB)
        let p = 0;
        const max = Math.min(beforeB.length, afterB.length);
        while (p < max && beforeB[p] === afterB[p]) p++;
        let s = 0;
        while (s < max - p && beforeB[beforeB.length - 1 - s] === afterB[afterB.length - 1 - s]) s++;
        lastReplaceSpan = beforeB.length - s - p + (afterB.length - s - p);

        totalSamples.push(t3 - t0);
        nodesScannedSamples.push(delta.nodesScanned);
        toTextSamples.push(delta.toText);
      }

      const m = summarizeTimes(mutateSamples);
      const tr = summarizeTimes(transportSamples);
      const tot = summarizeTimes(totalSamples);
      const ns = [...nodesScannedSamples].sort((a, b) => a - b);
      const tt = [...toTextSamples].sort((a, b) => a - b);
      const med = (arr: number[]) => arr[Math.floor(arr.length / 2)] ?? 0;

      rows.push({
        N_chars: A.size.N_chars,
        N_nodes: A.size.N_nodes,
        seed_ms: A.size.seed_ms,
        bytes_state: A.size.bytes_state,
        t_mutate_p50: m.p50,
        t_transport_p50: tr.p50,
        t_total_p50: tot.p50,
        nodesScanned_med: med(ns),
        toText_med: med(tt),
        replaceSpan: lastReplaceSpan,
      });
    }

    // Print for the agent/user to read
    // eslint-disable-next-line no-console
    console.log("\n=== W1 remote mid insert — model path ===");
    // eslint-disable-next-line no-console
    console.table(rows);

    // S9: local mutate path is at most linear in nodesScanned
    assertAtMostLinear(
      rows.map((r) => ({ n: r.N_nodes, y: Math.max(1, r.nodesScanned_med) })),
      { label: "S9 nodesScanned on insertTextAt", max: 1.25 },
    );

    // S4-ish: single remote 1-char insert → replace span O(1)
    for (const r of rows) {
      expect(r.replaceSpan).to.be.lessThanOrEqual(4);
    }

    // Record α for reporting
    const aNs = alpha(rows.map((r) => ({ n: r.N_nodes, y: Math.max(1, r.nodesScanned_med) })));
    const aMut = alpha(rows.map((r) => ({ n: r.N_nodes, y: Math.max(0.001, r.t_mutate_p50) })));
    // eslint-disable-next-line no-console
    console.log(`α(nodesScanned)=${aNs.toFixed(3)}  α(t_mutate_p50)=${aMut.toFixed(3)}`);
  });

  it("S5 [EC-G4/EL-G2]: batched two-site insert decomposes into 2 minimal replaces (textDiffs)", () => {
    // N3 / B7: multi-hunk textDiffs must not span the document for two distant inserts.
    const N = 4_000;
    const A = plain(N);
    const before = toText(A.root);
    // Two inserts in one "batch" (same local doc before sync)
    insertTextAt(A.root, 0, "A");
    insertTextAt(A.root, toText(A.root).length, "Z");
    const after = toText(A.root);

    const hunks = textDiffs(before, after);
    const replaceCount = hunks.length;
    const replaceCharsMax =
      hunks.length === 0 ? 0 : Math.max(...hunks.map((h) => h.to - h.from + h.insert.length));

    // eslint-disable-next-line no-console
    console.log(
      `S5: N=${N} replaceCount=${replaceCount} replaceCharsMax=${replaceCharsMax} (want 2 and ≤4)`,
    );

    expect(replaceCount).to.equal(2);
    expect(replaceCharsMax).to.be.lessThanOrEqual(4);
  });
});

describe("plexus-text bench — seed cost (EC-G3 entity explosion)", () => {
  it("reports seed_ms and entity counts for plain(N)", () => {
    const sizes = [1_000, 4_000, 16_000];
    const rows = sizes.map((N) => {
      const p = plain(N);
      return {
        N_chars: p.size.N_chars,
        N_atoms: p.size.N_atoms,
        N_nodes: p.size.N_nodes,
        N_entities: p.size.N_entities,
        bytes_state: p.size.bytes_state,
        seed_ms: Math.round(p.size.seed_ms * 10) / 10,
        atomsCreated: p.size.seed_delta.atomsCreated,
      };
    });
    // eslint-disable-next-line no-console
    console.log("\n=== Seed cost plain(N) ===");
    // eslint-disable-next-line no-console
    console.table(rows);

    // Entity count tracks chars (one atom per code unit)
    for (const r of rows) {
      expect(r.N_atoms).to.equal(r.N_chars);
      expect(r.atomsCreated).to.equal(r.N_chars);
    }
  });
});
