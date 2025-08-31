import { AllowedYJSValue } from "./proxy-runtime-types";

export class RestrictedSet extends Set<AllowedYJSValue> {
  add(): never {
    throw new Error("modifications are restricted for that entity");
  }

  delete(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }

  // convenience aliases used elsewhere in API shape
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }
}

export class RestrictedArray extends Array<AllowedYJSValue> {
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }
}

export class RestrictedRecord extends Object {
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }
}
