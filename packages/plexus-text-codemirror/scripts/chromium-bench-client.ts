/**
 * Browser-side harness loaded by chromium-large-bench.mjs via Vite.
 */
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import * as Y from "yjs";

import { plexusTextSync } from "../src/index.js";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function lorem(n: number): string {
  const unit = "lorem ipsum dolor sit amet ";
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

(window as unknown as { __cmBenchReady: boolean }).__cmBenchReady = true;

(
  window as unknown as {
    __runCmBench: (
      N: number,
      keystrokes: number,
      warmup: number,
    ) => Promise<{
      N_chars: number;
      N_nodes: number;
      seed_ms: number;
      t_key_p50: number;
      t_key_p95: number;
      t_key_max: number;
      editor_len: number;
    }>;
  }
).__runCmBench = async (N, keystrokes, warmup) => {
  const host = document.getElementById("host")!;
  host.innerHTML = "";

  const id = `cm-chrome-${N}-${Math.random().toString(36).slice(2)}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc) as Plexus<PlexusText>;
  const root = plexus.root as PlexusText;

  const tSeed0 = performance.now();
  insertTextAt(root, 0, lorem(N));
  const seed_ms = performance.now() - tSeed0;

  const view = new EditorView({
    doc: toText(root),
    parent: host,
    extensions: [basicSetup, plexusTextSync(root, { doc, plexus })],
  });

  // Focus and place caret at end
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length } });

  const samples: number[] = [];
  const total = warmup + keystrokes;
  for (let i = 0; i < total; i++) {
    const t0 = performance.now();
    // Real DOM keystroke path: dispatch a user-like insert at caret
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: "x" },
      selection: { anchor: view.state.selection.main.head + 1 },
      userEvent: "input.type",
    });
    // Allow layout/paint microtasks
    await Promise.resolve();
    const t1 = performance.now();
    if (i >= warmup) samples.push(t1 - t0);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const result = {
    N_chars: toText(root).length,
    N_nodes: root.nodes.length,
    seed_ms,
    t_key_p50: percentile(sorted, 50),
    t_key_p95: percentile(sorted, 95),
    t_key_max: sorted[sorted.length - 1] ?? 0,
    editor_len: view.state.doc.length,
  };

  view.destroy();
  return result;
};
