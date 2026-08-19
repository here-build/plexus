import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: ["../public"],
  typescript: {
    check: false,
    reactDocgen: false,
  },
  async viteFinal(config) {
    config.resolve ??= {};
    // Bindings are plain TS (no decorators) — alias to source for HMR.
    // Do NOT alias @here.build/plexus-text (or @here.build/plexus): they use
    // stage-3 decorators + `accessor` fields. Vite/esbuild strips types only,
    // so the browser gets `@syncing accessor x` → SyntaxError. Use package
    // exports → dist (tsc already lowered decorators via tslib).
    config.resolve.alias = [
      ...(Array.isArray(config.resolve.alias) ? config.resolve.alias : []),
      {
        find: "@here.build/plexus-text-codemirror",
        replacement: path.resolve(root, "../plexus-text-codemirror/src/index.ts"),
      },
      {
        find: "@here.build/plexus-text-lexical",
        replacement: path.resolve(root, "../plexus-text-lexical/src/index.ts"),
      },
    ];
    config.optimizeDeps ??= {};
    // Never prebundle Plexus packages: esbuild would inline a second copy of
    // @here.build/plexus into the plexus-text chunk. getInternals is a module-
    // private WeakMap — dual copies → bootstrap fails with
    // "Cannot set properties of undefined (setting 'isRoot')".
    config.optimizeDeps.exclude = [
      ...new Set([
        ...(config.optimizeDeps.exclude ?? []),
        "@here.build/plexus",
        "@here.build/plexus-text",
        "@here.build/plexus-text-codemirror",
        "@here.build/plexus-text-lexical",
        "@here.build/y-messageport",
      ]),
    ];
    config.optimizeDeps.include = [
      ...(config.optimizeDeps.include ?? []),
      "react",
      "react/jsx-runtime",
      "react-dom",
      "react-dom/client",
      "yjs",
      "lexical",
      "tslib",
      "@lexical/react/LexicalComposer",
      "@lexical/react/LexicalRichTextPlugin",
      "@lexical/react/LexicalContentEditable",
      "@lexical/react/LexicalHistoryPlugin",
      "@lexical/react/LexicalOnChangePlugin",
      "@lexical/react/LexicalErrorBoundary",
    ];
    config.server ??= {};
    config.server.fs ??= {};
    config.server.fs.allow = [
      ...((config.server.fs.allow as string[]) ?? []),
      path.resolve(root, "../../.."),
      path.resolve(root, "../../../../plexus"),
    ];
    return config;
  },
};

export default config;
