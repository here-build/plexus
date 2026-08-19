import type { DurableObjectNamespace } from "@cloudflare/workers-types";

import type { ToyLogDO } from "./ToyLogDO.js";
import type { ToyProjectDO } from "./ToyProjectDO.js";

export interface Env {
  TOY_PROJECT: DurableObjectNamespace<ToyProjectDO>;
  TOY_LOG: DurableObjectNamespace<ToyLogDO>;
}
