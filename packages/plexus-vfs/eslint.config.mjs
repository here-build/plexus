import { nodejs } from "@here.build/eslint-configs";

export default [
  // Tooling configs aren't part of the tsconfig program, so typed-linting has no
  // type info for them. `eslint.config.*` is already ignored by the preset; the
  // vitest config is the same category (build/test tooling, not src).
  { ignores: ["dist/*", "node_modules/*", "vitest.config.ts"] },
  ...nodejs,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Tests intentionally use console, construct entities for side effects,
      // and re-key records to verify ownership re-parenting.
      "no-console": "off",
      "sonarjs/constructor-for-side-effects": "off",
      "sonarjs/no-element-overwrite": "off",
      // isomorphic-git's DEFAULT export IS the namespace object (`git.init(...)`
      // is the documented API). It also re-exports those as named exports, which
      // trips this rule — but `import git from "isomorphic-git"` + `git.init` is
      // exactly correct here.
      "import-x/no-named-as-default-member": "off",
    },
  },
];
