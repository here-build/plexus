// Global registry for undo notifications - Y entities are singletons anyway
import type * as Y from "yjs";

export const undoManagerNotifications = new WeakMap<
  Y.AbstractType<any>,
  ((event: Y.YEvent<any>) => void) | ((event: Y.YMapEvent<any>) => void)
>();
