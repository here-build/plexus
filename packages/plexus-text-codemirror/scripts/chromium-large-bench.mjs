/**
 * Headless Chromium: large-doc typing latency with CodeMirror + PlexusText.
 *
 *   pnpm run benchmarks:chromium
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SIZES = [1_000, 4_000, 16_000];
const KEYSTROKES = 30;
const WARMUP = 8;

async function main() {
  const server = await createServer({
    root,
    configFile: false,
    server: {
      port: 5198,
      strictPort: true,
      fs: {
        allow: [
          root,
          path.resolve(root, ".."),
          path.resolve(root, "../../../../plexus"),
          path.resolve(root, "../../../../commons"),
          path.resolve(root, "../../../../node_modules"),
        ],
      },
    },
    optimizeDeps: {
      include: ["yjs", "mobx", "@codemirror/state", "@codemirror/view", "codemirror"],
    },
    resolve: {
      // Longer / more specific aliases first — Vite matches in order for string keys.
      alias: [
        // Use tsc dist (decorators lowered) — Vite/esbuild leave `@syncing accessor` raw.
        {
          find: "@here.build/plexus-text/bench",
          replacement: path.resolve(root, "../plexus-text/dist/bench/index.js"),
        },
        {
          find: "@here.build/plexus-text",
          replacement: path.resolve(root, "../plexus-text/dist/index.js"),
        },
        {
          find: "@here.build/plexus",
          replacement: path.resolve(root, "../../../../plexus/packages/plexus/dist/index.js"),
        },
      ],
    },
  });
  await server.listen();
  const urls = server.resolvedUrls?.local ?? [];
  const base = urls[0]?.replace(/\/$/, "") || "http://127.0.0.1:5198";
  console.log("vite", base, server.resolvedUrls);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err));

  const results = [];

  for (const N of SIZES) {
    await page.goto(`${base}/bench.html`, { waitUntil: "networkidle", timeout: 120_000 });
    try {
      await page.waitForFunction(() => window.__cmBenchReady === true, null, { timeout: 90_000 });
    } catch (e) {
      console.error("ready timeout; page content:", await page.content());
      throw e;
    }

    const row = await page.evaluate(
      async ({ N, KEYSTROKES, WARMUP }) => window.__runCmBench(N, KEYSTROKES, WARMUP),
      { N, KEYSTROKES, WARMUP },
    );
    results.push(row);
    console.log(
      `N=${N} seed_ms=${row.seed_ms.toFixed(1)} t_key_p50=${row.t_key_p50.toFixed(2)}ms t_key_p95=${row.t_key_p95.toFixed(2)}ms N_nodes=${row.N_nodes}`,
    );
  }

  console.log("\n=== Chromium CodeMirror large-file keystroke latency ===");
  console.table(results);

  await browser.close();
  await server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
