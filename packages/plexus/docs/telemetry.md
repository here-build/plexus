# Setting Up Telemetry

Plexus instruments its hot paths (tracking, sync, awareness) through a zero-dependency telemetry
facade. By default every probe is a no-op — no adapter installed, no overhead beyond a boolean
check. Install an adapter to route metrics into your observability stack (OpenTelemetry,
Prometheus, a console logger — anything).

## The adapter contract

```typescript
interface TelemetryAdapter {
  /** Monotonic counter increment. `delta` defaults to 1. */
  counter(name: string, attrs?: TelemetryAttributes, delta?: number): void;
  /** Point-in-time value sample. */
  gauge(name: string, value: number, attrs?: TelemetryAttributes): void;
  /** Distribution sample (latency, size, count, etc.). */
  histogram(name: string, value: number, attrs?: TelemetryAttributes): void;
  /** Begin a span. Caller calls `.end()` (typically in `finally`). End is idempotent. */
  span(name: string, attrs?: TelemetryAttributes): TelemetrySpan;
}

type TelemetryAttributes = Record<string, string | number | boolean>;
```

All methods are best-effort: an adapter must never throw into the call site.

## Installing

```typescript
import { setTelemetryAdapter } from "@here.build/plexus";

setTelemetryAdapter({
  counter(name, attrs, delta = 1) {
    meter.createCounter(name).add(delta, attrs);
  },
  gauge(name, value, attrs) {
    meter.createGauge(name).record(value, attrs);
  },
  histogram(name, value, attrs) {
    meter.createHistogram(name).record(value, attrs);
  },
  span(name, attrs) {
    const s = tracer.startSpan(name, { attributes: attrs });
    return {
      setAttribute: (k, v) => s.setAttribute(k, v),
      end: () => s.end(),
    };
  },
});

setTelemetryAdapter(null); // revert to the no-op default
```

Install once at boot. Tests that install an adapter reset between cases with
`setTelemetryAdapter(null)`.

## Emitting (plexus-family code)

```typescript
import { telemetry } from "@here.build/plexus";

if (telemetry.enabled) {
  // gate on `enabled` so the attrs object literal is never allocated on the hot path
  telemetry.counter("plexus.tracking.access", { entity_type: entityType, tracker_kind: kind });
}
```

`telemetry.enabled` is `true` only while an adapter is installed. Dispatch always goes through
the active adapter, so an un-gated call is still safe — just a no-op closure invocation.

## Attribute vocabulary

Exported helpers keep metric cardinality bounded:

- `TRACKER_KIND` — categorical labels for the `tracker_kind` attribute (the four tracking
  symbols plus `named` for specific-field trackers).
- `ORIGIN_KIND` — categorical labels for the `origin_kind` attribute.
- `COLLECTION_ENTITY_TYPE` (`"_collection"`) — the `entity_type` label used for collection nodes.
- `bucketCount(n)` / `bucketBytes(n)` — log-scale bucketing so unbounded counts/sizes become
  low-cardinality attribute values.

Attribute values are primitives; exporters coerce them to strings. Cardinality discipline lives
at the call site — bucket anything unbounded before attaching it.
