/**
 * PEW app domain — durable work types + author-facing action shapes.
 * Claim owners and resolvers do not live here.
 */

export { type Lifecycle, type TerminalLifecycle, TERMINAL_LIFECYCLES, isTerminal } from "./lifecycle.js";

export { PewTerminalWriteError } from "./errors.js";

export { Expectation } from "./expectation.js";

export {
  type SettleSurfaceDisposition,
  type CancelIntent,
  type SettleSurfaceIntent,
  type PewIntent,
} from "./intents.js";
