/**
 * CodeMirror binding: remote 1-char insert timing + E1 firing decomposition.
 */
import { EditorView } from "@codemirror/view";
import {
  alpha,
  connectPeer,
  plain,
  summarizeTimes,
  syncAtoB,
  withCounterWindow,
} from "@here.build/plexus-text/bench";
import { insertTextAt, toText } from "@here.build/plexus-text";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { plexusTextSync } from "../index.js";

const SIZES = [500, 1_000, 2_000] as const;

describe("plexus-text-codemirror bench — binding W1 remote mid insert", () => {
  it("measures t_apply + nodesScanned + E1 firings across sizes", () => {
    const rows: Array<Record<string, number>> = [];
    const e1Rows: Array<Record<string, number>> = [];

    for (const N of SIZES) {
      const A = plain(N);
      const B = connectPeer(A.doc);
      const viewB = new EditorView({
        doc: toText(B.root),
        extensions: [plexusTextSync(B.root, B.doc)],
      });

      for (let i = 0; i < 5; i++) {
        insertTextAt(A.root, N + i, "w");
        syncAtoB(A.doc, B.doc);
      }

      const applySamples: number[] = [];
      const totalSamples: number[] = [];
      const nodesScannedSamples: number[] = [];
      const toTextSamples: number[] = [];
      const pullsSamples: number[] = [];
      const projKeySamples: number[] = [];
      const segmentsSamples: number[] = [];

      const measured = 15;
      for (let i = 0; i < measured; i++) {
        const offset = Math.floor(N / 2);
        const t0 = performance.now();
        insertTextAt(A.root, offset, "Z");
        const update = Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc));

        const { delta } = withCounterWindow(() => {
          const t1 = performance.now();
          Y.applyUpdate(B.doc, update);
          const t2 = performance.now();
          applySamples.push(t2 - t1);
          totalSamples.push(t2 - t0);
        });

        nodesScannedSamples.push(delta.nodesScanned);
        toTextSamples.push(delta.toText);
        pullsSamples.push(delta.pulls);
        projKeySamples.push(delta.projectionKeyCalls);
        segmentsSamples.push(delta.segments);
      }

      const apply = summarizeTimes(applySamples);
      const total = summarizeTimes(totalSamples);
      const ns = [...nodesScannedSamples].sort((a, b) => a - b);
      const med = (a: number[]) => a[Math.floor(a.length / 2)] ?? 0;

      rows.push({
        N_chars: A.size.N_chars,
        N_nodes: A.size.N_nodes,
        t_apply_p50: apply.p50,
        t_apply_p95: apply.p95,
        t_total_p50: total.p50,
        nodesScanned_med: med(ns),
        toText_med: med([...toTextSamples].sort((a, b) => a - b)),
        editor_len: viewB.state.doc.length,
      });

      e1Rows.push({
        N,
        pulls_med: med([...pullsSamples].sort((a, b) => a - b)),
        projectionKeyCalls_med: med([...projKeySamples].sort((a, b) => a - b)),
        toText_med: med([...toTextSamples].sort((a, b) => a - b)),
        segments_med: med([...segmentsSamples].sort((a, b) => a - b)),
        nodesScanned_med: med(ns),
      });

      viewB.destroy();
    }

    // eslint-disable-next-line no-console
    console.log("\n=== CodeMirror binding W1 remote mid insert ===");
    // eslint-disable-next-line no-console
    console.table(rows);
    // eslint-disable-next-line no-console
    console.log("\n=== E1 firing decomposition (1 remote mid-insert) ===");
    // eslint-disable-next-line no-console
    console.table(e1Rows);

    const aNs = alpha(rows.map((r) => ({ n: r.N_nodes, y: Math.max(1, r.nodesScanned_med) })));
    const aT = alpha(rows.map((r) => ({ n: r.N_nodes, y: Math.max(0.001, r.t_apply_p50) })));
    // eslint-disable-next-line no-console
    console.log(`α(nodesScanned)=${aNs.toFixed(3)}  α(t_apply_p50)=${aT.toFixed(3)}`);

    // N1: one pull per remote batch; projectionKeyCalls constant (scheduler coalesce)
    for (const r of e1Rows) {
      expect(r.pulls_med).to.be.at.most(2);
      expect(r.projectionKeyCalls_med).to.be.at.most(2);
      // N2: one toText per pull cycle (reaction tracking; pull reuses)
      expect(r.toText_med).to.be.at.most(2);
    }
    // After N1+N2: nodesScanned is linear in N (one projection), not N²
    expect(aNs).to.be.lessThan(1.3);
  });
});
