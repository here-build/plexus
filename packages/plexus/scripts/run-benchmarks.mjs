#!/usr/bin/env node
/**
 * Comprehensive Benchmark Runner for Plexus vs MobX
 *
 * Runs all performance tests and generates detailed reports with:
 * - Performance metrics comparison
 * - Memory usage analysis
 * - Regression detection
 * - HTML report generation
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const reportsDir = join(packageRoot, "benchmark-reports");

// Ensure reports directory exists
if (!existsSync(reportsDir)) {
  mkdirSync(reportsDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportFilename = `benchmark-report-${timestamp}`;

console.log("🚀 Starting Comprehensive Plexus vs MobX Benchmark Suite");
console.log("=".repeat(80));

// Configuration
const config = {
  warmupRuns: 3,
  benchmarkRuns: 10,
  memoryProfiling: true,
  generateHtmlReport: true,
  enableGC: true
};

console.log("Configuration:", config);
console.log();

// Test suites to run
const testSuites = [
  {
    name: "Core Performance Benchmarks",
    file: "performance-benchmark.bench.ts",
    description: "Object creation, property access, mutations, reactivity"
  },
  {
    name: "Edge Case Performance",
    file: "edge-case-performance.bench.ts",
    description: "Sparse arrays, deep chains, circular references, concurrent access"
  },
  {
    name: "Memory Usage Analysis",
    file: "memory-usage.test.ts",
    description: "Memory profiling, leak detection, GC behavior"
  }
];

const results = {
  timestamp,
  config,
  testResults: [],
  summary: {},
  systemInfo: {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + "GB"
  }
};

console.log("System Information:");
console.log("  Node.js:", results.systemInfo.nodeVersion);
console.log("  Platform:", results.systemInfo.platform, results.systemInfo.arch);
console.log("  CPU Cores:", results.systemInfo.cpuCount);
console.log("  Memory:", results.systemInfo.totalMemory);
console.log();

// Run each test suite
for (const suite of testSuites) {
  console.log(`📊 Running ${suite.name}...`);
  console.log(`   ${suite.description}`);

  const startTime = Date.now();

  try {
    // Build the vitest command - use 'bench' for benchmark tests, 'run' for regular tests
    const isBenchmarkSuite = suite.file.endsWith(".bench.ts");
    const vitestCommand = isBenchmarkSuite ? "bench" : "run";
    const vitestArgs = [vitestCommand, "--reporter=verbose", `src/__tests__/${suite.file}`];

    if (config.enableGC) {
      // Add GC flag for memory tests
      process.env.NODE_OPTIONS = "--expose-gc";
    }

    // Run the test
    const output = execSync(`npx vitest ${vitestArgs.join(" ")}`, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: "pipe"
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`   ✅ Completed in ${duration}ms`);

    results.testResults.push({
      suite: suite.name,
      file: suite.file,
      description: suite.description,
      duration,
      status: "success",
      output: output.trim()
    });
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`   ❌ Failed after ${duration}ms`);
    console.error("Error:", error.message);

    results.testResults.push({
      suite: suite.name,
      file: suite.file,
      description: suite.description,
      duration,
      status: "failed",
      error: error.message,
      output: error.stdout?.toString() || ""
    });
  }

  console.log();
}

// Analyze results
console.log("📈 Analyzing Results...");

const successfulTests = results.testResults.filter((r) => r.status === "success");
const failedTests = results.testResults.filter((r) => r.status === "failed");

results.summary = {
  totalSuites: testSuites.length,
  successfulSuites: successfulTests.length,
  failedSuites: failedTests.length,
  totalDuration: results.testResults.reduce((sum, r) => sum + r.duration, 0),
  successRate: Math.round((successfulTests.length / testSuites.length) * 100)
};

console.log("Summary:");
console.log(`  Total Test Suites: ${results.summary.totalSuites}`);
console.log(`  Successful: ${results.summary.successfulSuites}`);
console.log(`  Failed: ${results.summary.failedSuites}`);
console.log(`  Success Rate: ${results.summary.successRate}%`);
console.log(`  Total Duration: ${results.summary.totalDuration}ms`);
console.log();

// Generate reports
console.log("📝 Generating Reports...");

// JSON Report
const jsonReportPath = join(reportsDir, `${reportFilename}.json`);
writeFileSync(jsonReportPath, JSON.stringify(results, null, 2));
console.log(`  JSON Report: ${jsonReportPath}`);

// Text Report
const textReport = generateTextReport(results);
const textReportPath = join(reportsDir, `${reportFilename}.txt`);
writeFileSync(textReportPath, textReport);
console.log(`  Text Report: ${textReportPath}`);

// HTML Report (if enabled)
if (config.generateHtmlReport) {
  const htmlReport = generateHtmlReport(results);
  const htmlReportPath = join(reportsDir, `${reportFilename}.html`);
  writeFileSync(htmlReportPath, htmlReport);
  console.log(`  HTML Report: ${htmlReportPath}`);
}

console.log();
console.log("🎉 Benchmark Complete!");

if (results.summary.successRate < 100) {
  console.log("⚠️  Some tests failed. Check the reports for details.");
  process.exit(1);
} else {
  console.log("✅ All benchmarks completed successfully.");
}

// Report generation functions
function generateTextReport(results) {
  let report = "";

  report += `PLEXUS vs MOBX PERFORMANCE BENCHMARK REPORT\n`;
  report += `${"=".repeat(60)}\n\n`;

  report += `Generated: ${new Date(results.timestamp).toLocaleString()}\n`;
  report += `System: ${results.systemInfo.platform} ${results.systemInfo.arch} (${results.systemInfo.cpuCount} cores, ${results.systemInfo.totalMemory})\n`;
  report += `Node.js: ${results.systemInfo.nodeVersion}\n\n`;

  report += `SUMMARY\n`;
  report += `${"=".repeat(20)}\n`;
  report += `Total Test Suites: ${results.summary.totalSuites}\n`;
  report += `Successful: ${results.summary.successfulSuites}\n`;
  report += `Failed: ${results.summary.failedSuites}\n`;
  report += `Success Rate: ${results.summary.successRate}%\n`;
  report += `Total Duration: ${results.summary.totalDuration}ms\n\n`;

  report += `DETAILED RESULTS\n`;
  report += `${"=".repeat(20)}\n`;

  for (const result of results.testResults) {
    report += `\n${result.suite}\n`;
    report += `${"-".repeat(result.suite.length)}\n`;
    report += `Status: ${result.status.toUpperCase()}\n`;
    report += `Duration: ${result.duration}ms\n`;
    report += `Description: ${result.description}\n`;

    if (result.status === "failed") {
      report += `Error: ${result.error}\n`;
    }

    if (result.output) {
      report += `\nOutput:\n${result.output}\n`;
    }
  }

  return report;
}

function generateHtmlReport(results) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Plexus vs MobX Benchmark Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
    .metric { background: #ecf0f1; padding: 20px; border-radius: 6px; text-align: center; }
    .metric-value { font-size: 2em; font-weight: bold; color: #2c3e50; }
    .metric-label { color: #7f8c8d; font-size: 0.9em; }
    .test-suite { margin: 20px 0; padding: 20px; border: 1px solid #ddd; border-radius: 6px; }
    .status-success { color: #27ae60; }
    .status-failed { color: #e74c3c; }
    .output { background: #2c3e50; color: #ecf0f1; padding: 15px; border-radius: 4px; font-family: 'Monaco', 'Consolas', monospace; font-size: 0.85em; overflow-x: auto; }
    .system-info { background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Plexus vs MobX Performance Benchmark</h1>
    
    <div class="system-info">
      <h3>System Information</h3>
      <table>
        <tr><td><strong>Generated:</strong></td><td>${new Date(results.timestamp).toLocaleString()}</td></tr>
        <tr><td><strong>Platform:</strong></td><td>${results.systemInfo.platform} ${results.systemInfo.arch}</td></tr>
        <tr><td><strong>CPU Cores:</strong></td><td>${results.systemInfo.cpuCount}</td></tr>
        <tr><td><strong>Memory:</strong></td><td>${results.systemInfo.totalMemory}</td></tr>
        <tr><td><strong>Node.js:</strong></td><td>${results.systemInfo.nodeVersion}</td></tr>
      </table>
    </div>
    
    <h2>Summary</h2>
    <div class="summary">
      <div class="metric">
        <div class="metric-value">${results.summary.totalSuites}</div>
        <div class="metric-label">Total Test Suites</div>
      </div>
      <div class="metric">
        <div class="metric-value status-success">${results.summary.successfulSuites}</div>
        <div class="metric-label">Successful</div>
      </div>
      <div class="metric">
        <div class="metric-value status-failed">${results.summary.failedSuites}</div>
        <div class="metric-label">Failed</div>
      </div>
      <div class="metric">
        <div class="metric-value">${results.summary.successRate}%</div>
        <div class="metric-label">Success Rate</div>
      </div>
      <div class="metric">
        <div class="metric-value">${results.summary.totalDuration}</div>
        <div class="metric-label">Total Duration (ms)</div>
      </div>
    </div>
    
    <h2>Test Results</h2>
    ${results.testResults
      .map(
        (result) => `
      <div class="test-suite">
        <h3>${result.suite}</h3>
        <p><strong>Status:</strong> <span class="status-${result.status}">${result.status.toUpperCase()}</span></p>
        <p><strong>Duration:</strong> ${result.duration}ms</p>
        <p><strong>Description:</strong> ${result.description}</p>
        ${result.error ? `<p><strong>Error:</strong> <span class="status-failed">${result.error}</span></p>` : ""}
        ${
          result.output
            ? `
          <h4>Output</h4>
          <div class="output">${result.output.replace(/\n/g, "<br>")}</div>
        `
            : ""
        }
      </div>
    `
      )
      .join("")}
    
    <footer style="margin-top: 50px; text-align: center; color: #7f8c8d; font-size: 0.9em;">
      Generated by Plexus Benchmark Suite • ${new Date().getFullYear()}
    </footer>
  </div>
</body>
</html>`;
}
