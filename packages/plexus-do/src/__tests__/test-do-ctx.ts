/** Minimal DurableObjectState fake for DO integration tests. */

/**
 * Server-wrap WebSocket fake — satisfies `RawWebSocketLike` (readyState/send/close)
 * plus the hibernation attachment surface the leader reads on close.
 */
export class FakeServerWebSocket {
  readonly sent: Array<ArrayBuffer | string> = [];
  readyState = 1;
  binaryType = "arraybuffer";
  private attachment: unknown = null;

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    this.sent.push(typeof data === "string" ? data : toArrayBuffer(data));
  }

  close(): void {
    this.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** Only the reassembled binary frames — drops the chunked-transport reset/text markers. */
  binaryFrames(): Uint8Array[] {
    return this.sent.filter((f): f is ArrayBuffer => typeof f !== "string").map((b) => new Uint8Array(b));
  }
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return bytes.buffer;
}

export class FakeStorage {
  private readonly data = new Map<string, unknown>();
  private alarm: number | null = null;
  readonly failPutKeys = new Set<string>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (this.failPutKeys.has(key)) {
      throw new Error(`FakeStorage: put failed for ${key}`);
    }
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(when: number): Promise<void> {
    this.alarm = when;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.data.entries());
  }
}

export class FakeCtx {
  readonly storage = new FakeStorage();
  private readonly pending: Promise<unknown>[] = [];
  private readonly sockets: FakeServerWebSocket[] = [];
  private bootPromise: Promise<void> | undefined;

  getWebSockets(): WebSocket[] {
    return this.sockets as unknown as WebSocket[];
  }

  acceptWebSocket(ws: FakeServerWebSocket): void {
    this.sockets.push(ws);
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.bootPromise = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async waitForBoot(): Promise<void> {
    if (this.bootPromise) await this.bootPromise;
  }

  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      await Promise.allSettled(batch);
    }
  }
}