# Logger Configuration

## Overview

Plexus provides a simple, configurable logging system for error diagnostics.

**Browser:** Always logs to console (use browser devtools to filter)
**Server:** Respects `PLEXUS_LOG_LEVEL` environment variable

**Default behavior:**

- **Browser:** Always logs to console
- **Server without `PLEXUS_LOG_LEVEL`:** Logs to console
- **Server with `PLEXUS_LOG_LEVEL`:** Filters based on level (error, warn, info, debug, silent)

## Browser Behavior

In browsers, Plexus always logs to console. Use browser developer tools to filter messages:

```typescript
import { PlexusModel, syncing } from "@here.build/plexus";

const node = new Node();
node.childVal = node; // Logs error to console, then throws
```

**Browser Console Filtering:**

- Chrome DevTools: Use the filter dropdown (Errors, Warnings, Info, Verbose)
- Firefox DevTools: Use the filter buttons (Error, Warn, Log, Info, Debug)
- Safari DevTools: Use the filter bar

No configuration needed - browser devtools are designed for this.

## Server-Side Configuration (Node.js)

On the server, set `PLEXUS_LOG_LEVEL` environment variable to control logging:

```bash
# .env or .env.local
PLEXUS_LOG_LEVEL=silent        # or: error, warn, info, debug
```

**Valid values:**

| Value    | What it logs                          |
|----------|---------------------------------------|
| `silent` | Nothing (default for production/test) |
| `error`  | Errors only (default for development) |
| `warn`   | Warnings + errors                     |
| `info`   | Info + warnings + errors              |
| `debug`  | Everything                            |

When `PLEXUS_LOG_LEVEL` is unset, the default is determined by `NODE_ENV`:
- `production` / `test` → `silent`
- `development` (or unset) → `error`

**Examples:**

```bash
# Production: silence all logs
PLEXUS_LOG_LEVEL=silent npm start

# Development: see all logs
PLEXUS_LOG_LEVEL=debug npm run dev

# Staging: errors only
PLEXUS_LOG_LEVEL=error npm start
```

## Programmatic Configuration

### Custom Logger (Server-Side)

You can replace the default console with any logger that has `error`, `warn`, `info`, and `debug` methods:

```typescript
import { setPlexusLogger } from "@here.build/plexus";

// Use any console-like logger
setPlexusLogger(console); // Default
setPlexusLogger(myCustomLogger);
```

### Silent Logger (Server-Side)

Create a silent logger for production:

```typescript
import { setPlexusLogger } from "@here.build/plexus";

setPlexusLogger({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});

// No console output, but errors still throw
node.childVal = node; // Throws silently
```

### Use Custom Logger

#### With Consola

```typescript
import consola from "consola";
import { setPlexusLogger } from "@here.build/plexus";

setPlexusLogger(consola);

// Uses consola.error() instead of console.error()
```

#### With Pino

```typescript
import pino from "pino";
import { setPlexusLogger } from "@here.build/plexus";

const logger = pino();

setPlexusLogger({
  error: (msg, ctx) => logger.error(ctx, msg),
  warn: (msg, ctx) => logger.warn(ctx, msg),
  info: (msg, ctx) => logger.info(ctx, msg),
  debug: (msg, ctx) => logger.debug(ctx, msg),
});
```

#### With Winston

```typescript
import winston from "winston";
import { setPlexusLogger } from "@here.build/plexus";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: "plexus.log" })],
});

setPlexusLogger({
  error: (msg, ctx) => logger.error(msg, ctx),
  warn: (msg, ctx) => logger.warn(msg, ctx),
  info: (msg, ctx) => logger.info(msg, ctx),
  debug: (msg, ctx) => logger.debug(msg, ctx),
});
```

## Environment Variables vs Programmatic Config

### When to Use Environment Variables

✅ **Use environment variables when:**

- You want consistent logging across entire application
- Configuration changes with environment (dev/staging/prod)
- You're using Docker/containers with env var injection
- You want zero-code configuration

**Example:**

```bash
# .env.production
PLEXUS_LOG_LEVEL=silent

# .env.development
PLEXUS_LOG_LEVEL=debug
```

### When to Use Programmatic Config

✅ **Use programmatic config when:**

- You need runtime control (enable debugging dynamically)
- Integrating with existing logger (consola, pino, winston)
- Different parts of app need different logging
- Testing scenarios that need specific logger behavior

**Example:**

```typescript
// Enable debug logging in specific feature
if (isFeatureFlagEnabled('verbose-logging')) {
  setPlexusLogger("debug");
}

// Use existing application logger
setPlexusLogger(myAppLogger);
```

### Combining Both

Environment variables set the default, programmatic calls override:

```typescript
// .env: PLEXUS_LOG_LEVEL=error

// At app startup, env var sets logger to "error"
// User enables debug mode in UI
setPlexusLogger("debug"); // Overrides env var

// Reset to env var setting
resetPlexusLogger(); // Back to "error" from env
```

## API Reference

### setPlexusLogger()

Configure the global Plexus logger.

```typescript
type PlexusLogger = Pick<Console, 'error' | 'warn' | 'info' | 'debug'>;

function setPlexusLogger(logger: PlexusLogger): void
```

**Parameters:**

- `logger` - Any object with `error`, `warn`, `info`, and `debug` methods (like `console`)

**Examples:**

```typescript
// Use console (default)
setPlexusLogger(console);

// Use custom logger (consola, pino, winston, etc.)
import consola from "consola";
setPlexusLogger(consola);

// Silent logger
setPlexusLogger({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});

// Custom implementation
setPlexusLogger({
  error: (msg, ctx) => myLogger.error(msg, ctx),
  warn: (msg, ctx) => myLogger.warn(msg, ctx),
  info: (msg, ctx) => myLogger.info(msg, ctx),
  debug: (msg, ctx) => myLogger.debug(msg, ctx),
});
```

### resetPlexusLogger()

Reset logger to default (console on browser, env-based filtering on server).

```typescript
function resetPlexusLogger(): void
```

**Example:**

```typescript
const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
setPlexusLogger(silentLogger);
// ... later
resetPlexusLogger(); // Back to default
```

### PlexusLogger Type

```typescript
type PlexusLogger = Pick<Console, 'error' | 'warn' | 'info' | 'debug'>;
```

Any object with these four methods. The `Console` interface from TypeScript's standard library works perfectly.

## Use Cases

### Production: Silent Logging

```typescript
if (process.env.NODE_ENV === "production") {
  setPlexusLogger("silent");
}
```

### Development: Verbose Logging

```typescript
if (process.env.NODE_ENV === "development") {
  setPlexusLogger("debug");
}
```

### Testing: Mock Logger

```typescript
import { describe, it, expect, vi } from "vitest";
import { setPlexusLogger, resetPlexusLogger } from "@here.build/plexus";

describe("my tests", () => {
  beforeEach(() => {
    const mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    setPlexusLogger(mockLogger);
  });

  afterEach(() => {
    resetPlexusLogger();
  });

  it("logs errors", () => {
    // Test error logging
  });
});
```

### Centralized Logging Service

```typescript
import { setPlexusLogger } from "@here.build/plexus";

setPlexusLogger({
  error: (msg, ctx) => {
    // Send to logging service
    fetch("/api/logs", {
      method: "POST",
      body: JSON.stringify({
        level: "error",
        message: msg,
        context: ctx,
        timestamp: Date.now(),
      }),
    });
  },
  // ... other methods
});
```

### Filter by Error Type

```typescript
import { setPlexusLogger } from "@here.build/plexus";

setPlexusLogger({
  error: (msg, ctx) => {
    // Only log cycle errors
    if (msg.includes("Cycle")) {
      console.error(msg, ctx);
    }
  },
  // ... other methods
});
```

### Add Custom Context

```typescript
import { setPlexusLogger } from "@here.build/plexus";

const userId = getCurrentUserId();

setPlexusLogger({
  error: (msg, ctx) => {
    console.error(msg, {
      ...ctx,
      userId,
      timestamp: Date.now(),
      environment: process.env.NODE_ENV,
    });
  },
  // ... other methods
});
```

## Log Levels

### Error (Default)

Logs only errors. This is the default level.

```typescript
setPlexusLogger("error");
```

**What it logs:**

- Cycle detection failures
- Self-adoption attempts
- Dependency modification attempts
- Root entity violations
- Document mismatches
- Duplicate child insertions

### Warn

Logs warnings and errors.

```typescript
setPlexusLogger("warn");
```

**Currently logs:** Same as error (Plexus doesn't have warnings yet)

### Info

Logs info, warnings, and errors.

```typescript
setPlexusLogger("info");
```

**Currently logs:** Same as error (Plexus doesn't have info logs yet)

### Debug

Logs everything including debug messages.

```typescript
setPlexusLogger("debug");
```

**Currently logs:** Same as error (Plexus doesn't have debug logs yet)

### Silent

Logs nothing.

```typescript
setPlexusLogger("silent");
```

**Use cases:**

- Production environments where errors are handled differently
- Testing when you don't want log noise
- When you're catching and handling all errors yourself

## Important Notes

### Errors Still Throw

Setting a logger or log level **does not prevent errors from being thrown**. It only controls what gets logged:

```typescript
setPlexusLogger("silent");

try {
  node.childVal = node; // Still throws!
} catch (error) {
  // Error is thrown even though logging is silent
  console.log("Caught:", error.message);
}
```

### Global Configuration

The logger is configured globally. Setting it once affects all Plexus operations:

```typescript
setPlexusLogger("silent");

const modelA = new ModelA();
const modelB = new ModelB();

// Both use silent logger
modelA.child = modelA; // Throws silently
modelB.child = modelB; // Throws silently
```

### Thread Safety

The logger is stored in a global variable. In multi-threaded environments (workers, etc.), each thread has its own
logger configuration.

### Performance

Logger calls happen **before** errors are thrown. If performance is critical:

1. Use `"silent"` mode
2. Use a no-op logger implementation
3. Filter in your custom logger

```typescript
// No-op logger for maximum performance
setPlexusLogger({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});
```

## Integration Examples

### Next.js

**Environment-based (recommended):**

```bash
# .env.local
PLEXUS_LOG_LEVEL=silent   # or error, debug, etc.
```

Next.js will automatically use this in both server and client code. No configuration needed!

**Programmatic (if needed):**

```typescript
// app/plexus-config.ts
import { setPlexusLogger } from "@here.build/plexus";

if (typeof window === "undefined") {
  // Server-side: silent or custom logger
  setPlexusLogger("silent");
} else {
  // Client-side: log to console
  setPlexusLogger("error");
}
```

### Vite + React

**Environment-based:**

```bash
# .env
VITE_PLEXUS_LOG_LEVEL=debug   # Development

# .env.production
VITE_PLEXUS_LOG_LEVEL=silent  # Production
```

Vite will inject these at build time. No code needed!

### Express.js

**Environment-based:**

```bash
# .env
PLEXUS_LOG_LEVEL=error
```

**Or integrate with existing logger:**

```typescript
// server.ts
import { setPlexusLogger } from "@here.build/plexus";
import { logger } from "./logger";

setPlexusLogger({
  error: (msg, ctx) => logger.error(msg, ctx),
  warn: (msg, ctx) => logger.warn(msg, ctx),
  info: (msg, ctx) => logger.info(msg, ctx),
  debug: (msg, ctx) => logger.debug(msg, ctx),
});
```

### Testing (Vitest/Jest)

**Environment-based (recommended):**

```bash
# vitest.config.ts or jest.config.js
export default {
  env: {
    PLEXUS_LOG_LEVEL: 'silent',  // Silence during tests
  },
}
```

**Or programmatically:**

```typescript
// vitest.setup.ts
import { beforeEach, afterEach } from "vitest";
import { setPlexusLogger, resetPlexusLogger } from "@here.build/plexus";

beforeEach(() => {
  setPlexusLogger("silent");
});

afterEach(() => {
  resetPlexusLogger();
});
```

Note: `NODE_ENV=test` automatically silences logs, so you may not need any configuration!

### Docker / Containers

Pass environment variables to your container:

**docker-compose.yml:**

```yaml
services:
  app:
    image: myapp:latest
    environment:
      - NODE_ENV=production
      - PLEXUS_LOG_LEVEL=error  # Override silent default
```

**Kubernetes:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  containers:
  - name: app
    image: myapp:latest
    env:
    - name: NODE_ENV
      value: "production"
    - name: PLEXUS_LOG_LEVEL
      value: "error"
```

**Docker run:**

```bash
docker run -e NODE_ENV=production -e PLEXUS_LOG_LEVEL=error myapp:latest
```

### Vercel / Netlify

Configure environment variables in the dashboard:

```
PLEXUS_LOG_LEVEL=silent
```

Or use `.env.production` committed to your repo (Vercel loads these automatically).

## Troubleshooting

### Logs Not Appearing

**Problem:** You expect logs but don't see them.

**Solutions:**

1. Check if logger is set to "silent"
2. Check if your custom logger is working
3. Verify errors are actually being thrown

```typescript
// Debug logger configuration
import { setPlexusLogger } from "@here.build/plexus";

setPlexusLogger({
  error: (msg, ctx) => {
    console.log("Logger called!");
    console.error(msg, ctx);
  },
  // ... other methods
});
```

### Too Many Logs

**Problem:** Logs are too noisy.

**Solutions:**

1. Set to "silent" mode
2. Filter in custom logger
3. Only log specific error types

```typescript
setPlexusLogger({
  error: (msg, ctx) => {
    // Only log in development
    if (process.env.NODE_ENV === "development") {
      console.error(msg, ctx);
    }
  },
  // ... other methods
});
```

### Logger Not Working with Library

**Problem:** Custom logger doesn't work with your logging library.

**Solution:** Check the logger's API and adapt:

```typescript
// Example: Adapting for different API
setPlexusLogger({
  error: (msg, ctx) => {
    // If your logger expects (level, message, meta)
    myLogger.log("error", msg, ctx);
  },
  // ... other methods
});
```

## Best Practices

1. **Configure early** - Set logger at app startup before any Plexus operations
2. **Use silent in tests** - Reduce test noise with `setPlexusLogger("silent")`
3. **Environment-specific config** - Different settings for dev/staging/prod
4. **Centralized logging** - Use custom logger to send to logging service
5. **Reset in tests** - Always `resetPlexusLogger()` after each test
6. **Don't rely on logs for control flow** - Errors still throw regardless of logging

## Summary

The Plexus logger provides:

- ✅ **Configurable** - Silent, custom logger, or log level
- ✅ **Compatible** - Works with consola, pino, winston, etc.
- ✅ **Flexible** - Filter, transform, route logs as needed
- ✅ **Non-intrusive** - Errors still throw normally
- ✅ **Global** - Configure once, affects all Plexus operations

Use it to integrate Plexus error diagnostics with your existing logging infrastructure!
