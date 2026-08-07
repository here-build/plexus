export { type TerminalLifecycle, TERMINAL_LIFECYCLES, isTerminal, isOpen, isActivatable } from "./lifecycle.js";

export {
  expectationLifecycleMachine,
  lifecycleAfter,
  lifecycleCan,
  lifecycleEventAfter,
  LIFECYCLE_EVENTS,
  type LifecycleEventName,
  type LifecycleEvent,
  type Lifecycle,
} from "./lifecycle-machine.js";

export { PewTerminalWriteError } from "./errors.js";

export {
  Expectation,
  Orchestration,
  LaunchDefinition,
  InProcessLaunchDefinition,
  SurfaceLaunchDefinition,
  type AnyExpectation,
  type ExpectationOf,
  type InputOf,
  type IntentOf,
  type LaunchDefinitionSnapshot,
  type ReportOf,
  type ResultOf,
} from "./models/index.js";

export {
  intentLaneField,
  cancellationLaneField,
  type CancellationRequestData,
  type EndCause,
  type CancellationStrength,
  type SettleSurfaceDisposition,
  type IntentLaneEntry,
  type CancellationLaneEntry,
  type IntentRecord,
} from "./control.js";

export { ExpectationState } from "./expectation-state.js";
export { PEWLoaderCatalog } from "./pew-loader-catalog.js";
export {
  PEWActorCatalog,
  collectIntentLane,
  collectCancellationLane,
} from "./pew-actor-catalog.js";

export {
  PEW,
  type ActorPresenceClient,
  type CatalogPresenceStatus,
  type ClaimPresenceStatus,
  type LoaderCapability,
  type LoaderHealth,
  type PewHubShape,
  type PewOpts,
  type PlanAvailability,
  type PresencePort,
} from "./presence.js";
