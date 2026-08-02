import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  makeHost,
  PewTestHost,
  SurfaceExpectation,
  SurfaceLaunchDefinition,
  TestExpectation,
  TestLoader,
} from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function surfaceHost(): Promise<{ host: PewTestHost; E: SurfaceExpectation }> {
  const host = new PewTestHost();
  host.plan(SurfaceExpectation.kind, new SurfaceLaunchDefinition(), new TestLoader());
  const E = host.mint(new SurfaceExpectation());
  await activateThroughLoad(host);
  return { host, E };
}

describe("surface settle", () => {
  it("allow / deny seal; the disposition is the answer, last report is null", async () => {
    for (const disposition of ["allow", "deny"] as const) {
      const { host, E } = await surfaceHost();
      cleanup.push(() => host.dispose());
      expect(E.state).toBe("running");
      expect(host.settleSurface(E, disposition)).toEqual({ ok: true });
      expect(E.state).toBe("sealed");
      expect(E.endCause).toBe("surface");
      expect(E.endDetail).toBe(disposition);
      expect(E.lastReportJson).toBe("null");
    }
  });

  it("abandon cancels", async () => {
    const { host, E } = await surfaceHost();
    cleanup.push(() => host.dispose());
    expect(host.settleSurface(E, "abandon")).toEqual({ ok: true });
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("surface");
  });

  it("refuses non-surface kinds and non-running states", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const tool = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(host.settleSurface(tool, "allow")).toEqual({ ok: false, code: "not_surface" });

    const surface = new PewTestHost();
    cleanup.push(() => surface.dispose());
    surface.plan(SurfaceExpectation.kind, new SurfaceLaunchDefinition(), new TestLoader());
    const pending = surface.mint(new SurfaceExpectation());
    expect(surface.settleSurface(pending, "allow")).toEqual({ ok: false, code: "not_running" });
  });
});
