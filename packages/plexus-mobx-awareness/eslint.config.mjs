import { shared } from "@here.build/eslint-configs";

export default [
  { ignores: ["dist/*", "node_modules/*", "vitest.config.ts", "eslint.config.mjs"] },
  ...shared,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Class modules match sibling packages (PlexusAwareness, ExpectationState).
      "unicorn/filename-case": "off",
      // DefaultedMap / ComputedMap factories close over `this` by design.
      "unicorn/consistent-function-scoping": "off",
      // Wire field values are undefined | null | T (getField contract).
      "sonarjs/function-return-type": "off",
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "no-console": "off",
      "sonarjs/no-nested-functions": "off",
      "sonarjs/constructor-for-side-effects": "off",
      "import-x/order": "off",
      "unicorn/prefer-structured-clone": "off",
      "unicorn/no-array-sort": "off",
    },
  },
];
