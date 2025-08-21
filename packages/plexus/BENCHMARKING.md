# Plexus Performance Benchmarking Guide

This comprehensive benchmarking suite compares Plexus performance against MobX across multiple dimensions including object creation, property access, mutations, reactivity, and memory usage.

## Quick Start

### Run All Benchmarks
```bash
npm run benchmark
```
This runs the complete benchmark suite and generates HTML, JSON, and text reports.

### Run Individual Test Suites
```bash
npm run benchmark:core      # Core performance tests
npm run benchmark:edge      # Edge case scenarios  
npm run benchmark:memory    # Memory usage analysis
npm run benchmark:all       # All individual suites
```

## Benchmark Categories

### 1. Core Performance (`performance-benchmark.test.ts`)
- **Object Creation**: Ephemeral vs Materialized vs MobX Observable
- **Property Access**: Simple, nested, collections
- **Array Operations**: Push, access patterns, large datasets
- **Map Operations**: Set, get, delete, enumeration
- **Reactivity Performance**: Tracking setup, notifications, multiple observers
- **Batch Updates**: Single vs batched property changes
- **Deep Hierarchies**: Complex nested object structures
- **Memory Lifecycle**: Object creation/destruction patterns
- **YJS Collaboration**: CRDT synchronization, materialization costs
- **Real-world Scenarios**: React component tree simulation

### 2. Edge Case Performance (`edge-case-performance.test.ts`)
- **Sparse Arrays**: Arrays with holes, length manipulation
- **Deep Proxy Chains**: Long linked lists, circular references
- **Property Enumeration**: Object.keys() on complex objects
- **Concurrent Access**: Multiple readers/writers, conflict resolution
- **Memory Stress**: Rapid creation/destruction cycles

### 3. Memory Usage Analysis (`memory-usage.test.ts`)
- **Memory Profiling**: Heap usage over time
- **Leak Detection**: Tracking system memory leaks
- **GC Behavior**: Garbage collection patterns
- **Array Memory**: Large array operation memory patterns
- **Deep Hierarchy Memory**: Tree structure memory usage

## Understanding the Results

### Benchmark Metrics

**Performance Benchmarks:**
- **ops/sec**: Operations per second (higher is better)
- **ms/op**: Milliseconds per operation (lower is better)
- **Relative Performance**: Comparison between Plexus and MobX

**Memory Metrics:**
- **Heap Growth**: Memory increase during test execution
- **Peak Heap**: Maximum memory usage
- **Average Heap**: Mean memory usage over time
- **GC Pressure**: Frequency and impact of garbage collection

### Key Performance Scenarios

#### Object Creation
- **Plexus Ephemeral**: Fastest - no YJS overhead
- **Plexus Materialized**: Moderate - includes YJS setup
- **MobX Observable**: Baseline comparison

#### Reactivity Systems
- **Plexus Tracking**: Granular field-level change detection
- **MobX Autorun**: Observable-based reactive updates

#### Memory Patterns
- **Plexus Proxy Overhead**: Memory cost of proxy wrappers
- **MobX Observable Overhead**: Memory cost of observable wrappers
- **YJS CRDT Overhead**: Additional memory for collaboration

## Running with Memory Profiling

For detailed memory analysis, run with garbage collection exposed:

```bash
node --expose-gc node_modules/.bin/vitest run src/__tests__/memory-usage.test.ts
```

This enables:
- Precise heap measurements
- Manual garbage collection
- Memory leak detection
- GC pressure analysis

## Interpreting Benchmark Reports

### HTML Report (`benchmark-reports/*.html`)
- Interactive dashboard with charts and metrics
- System information and test configuration
- Detailed output for each test suite
- Visual comparison between Plexus and MobX

### JSON Report (`benchmark-reports/*.json`)
- Machine-readable results for CI/CD integration
- Detailed timing and memory data
- Test execution metadata

### Text Report (`benchmark-reports/*.txt`)
- Human-readable summary
- Quick performance comparison
- Console-friendly format

## Performance Optimization Tips

### For Plexus
1. **Use Ephemeral Objects** when collaboration isn't needed
2. **Batch Materialization** to reduce YJS overhead
3. **Minimize Deep Proxy Chains** for better access performance
4. **Leverage Granular Tracking** to reduce unnecessary re-renders

### For MobX
1. **Use runInAction** for batched updates
2. **Dispose Autoruns** to prevent memory leaks
3. **Avoid Deep Observable Trees** for better performance
4. **Use observable.ref** for large objects that don't need deep observation

## Regression Testing

Run benchmarks regularly to detect performance regressions:

```bash
# Run weekly performance check
npm run benchmark

# Compare with previous results
diff benchmark-reports/latest.json benchmark-reports/previous.json
```

## Continuous Integration

Add benchmark runs to your CI pipeline:

```yaml
- name: Run Performance Benchmarks
  run: npm run benchmark
  
- name: Upload Benchmark Results
  uses: actions/upload-artifact@v2
  with:
    name: benchmark-reports
    path: benchmark-reports/
```

## Troubleshooting

### Common Issues

**High Memory Usage:**
- Run with `--expose-gc` flag for accurate measurements
- Ensure proper object cleanup in tests
- Check for circular references

**Inconsistent Results:**
- Run multiple iterations (`config.runs`)
- Ensure stable system conditions
- Disable other applications during benchmarking

**Test Failures:**
- Check Node.js version compatibility
- Verify MobX and Plexus versions
- Review error logs in detailed reports

### Performance Analysis

**Unexpectedly Slow Performance:**
1. Check if running in development vs production mode
2. Verify TypeScript compilation settings
3. Profile with Node.js debugging tools
4. Compare against baseline system performance

**Memory Leaks:**
1. Review tracking function cleanup
2. Check circular references in object graphs
3. Verify YJS document disposal
4. Use heap snapshots for detailed analysis

## Contributing

When adding new benchmarks:

1. **Follow Naming Conventions**: `benchmark-name.test.ts`
2. **Use Consistent Patterns**: Match existing test structure
3. **Document Test Purpose**: Clear descriptions in test names
4. **Include Memory Profiling**: For tests that create many objects
5. **Add to Test Suites**: Update `run-benchmarks.mjs` if needed

### Benchmark Design Guidelines

- **Isolate Measurements**: Each test should measure one specific aspect
- **Use Representative Data**: Test with realistic data sizes and patterns
- **Include Warmup Runs**: Eliminate JIT compilation effects
- **Control Variables**: Consistent test conditions across runs
- **Document Assumptions**: Clear about what each test is measuring
