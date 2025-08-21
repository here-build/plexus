import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Regular test configuration
    globals: true,
    environment: 'node',
  },
  // Benchmark mode configuration
  benchmark: {
    // Enable benchmarking
    outputFile: './benchmark-results.json',
  },
});