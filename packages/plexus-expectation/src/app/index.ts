/**
 * PEW app domain — durable work types + author-facing action shapes.
 * Claim owners and resolvers do not live here.
 */

export {
  type Lifecycle,
  type TerminalLifecycle,
  TERMINAL_LIFECYCLES,
  isTerminal,
  isOpen,
} from "./lifecycle.js";

export { PewCloneOpenError, PewTerminalWriteError } from "./errors.js";

export { Expectation, assertCloneable } from "./expectation.js";

export {
  type SettleSurfaceDisposition,
  type CancelIntent,
  type SettleSurfaceIntent,
  type PewIntent,
} from "./intents.js";
