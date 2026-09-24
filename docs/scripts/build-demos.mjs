import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const docs = dirname(scripts);
const repo = dirname(docs);

const demos = [
  {
    filter: "plexus-excalidraw-demo",
    base: "/plexus/excalidraw/",
    outDir: resolve(docs, "public/excalidraw"),
  },
  {
    filter: "plexus-xyflow-demo",
    base: "/plexus/xyflow/",
    outDir: resolve(docs, "public/xyflow"),
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["--filter", "@here.build/plexus", "--filter", "@here.build/y-messageport", "build"]);

for (const demo of demos) {
  run("pnpm", [
    "--filter",
    demo.filter,
    "exec",
    "vite",
    "build",
    "--base",
    demo.base,
    "--outDir",
    demo.outDir,
    "--emptyOutDir",
  ]);
}
