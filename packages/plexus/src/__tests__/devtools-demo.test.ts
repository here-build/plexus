import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildModelClass } from '../proxy-runtime.js';
import type { ModelType } from '../proxy-runtime-types.js';

describe('DevTools Demo', () => {
  type UserType = ModelType<{
    name: string;
    email: string;
    age: number;
    isActive: boolean;
  }, "User">;

  let User: ReturnType<typeof buildModelClass<UserType>>;

  beforeEach(() => {
    User = buildModelClass<UserType>("User", {
      name: "val",
      email: "val", 
      age: "val",
      isActive: "val"
    });
  });

  it('should show realistic DevTools usage', async () => {
    // Mock Redux DevTools
    const devToolsLog: any[] = [];
    global.window = {
      ...global.window,
      __REDUX_DEVTOOLS_EXTENSION__: {
        connect: () => ({
          send: (action: any, state: any) => {
            devToolsLog.push({ action, state });
            console.log('DevTools:', action.type, action.payload);
          }
        })
      }
    } as any;

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      // Create a user
      const user = User({
        name: "Alice",
        email: "alice@example.com", 
        age: 25,
        isActive: false
      });

      // Simulate a complex user interaction that updates multiple fields
      user.name = "Alice Smith";
      user.age = 26;
      user.email = "alice.smith@example.com";
      user.isActive = true;

      // Wait for batch to flush
      await new Promise(resolve => setImmediate(resolve));

      // Should have logged one batch with all mutations
      expect(devToolsLog).toHaveLength(1);
      
      const logEntry = devToolsLog[0];
      expect(logEntry.action.type).toBe('PLEXUS_BATCH_UPDATE');
      expect(logEntry.action.payload.count).toBe(4); // name, age, email, isActive
      
      // All mutations captured in one batch
      const mutations = logEntry.action.payload.mutations;
      expect(mutations).toContainEqual(
        expect.objectContaining({ field: 'name', value: 'Alice Smith' })
      );
      expect(mutations).toContainEqual(
        expect.objectContaining({ field: 'age', value: 26 })
      );
      expect(mutations).toContainEqual(
        expect.objectContaining({ field: 'email', value: 'alice.smith@example.com' })
      );
      expect(mutations).toContainEqual(
        expect.objectContaining({ field: 'isActive', value: true })
      );

    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});