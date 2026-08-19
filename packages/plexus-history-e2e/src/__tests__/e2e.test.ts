import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { JsonCut } from "@here.build/plexus-history/capture";

/* eslint-disable @typescript-eslint/no-explicit-any */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Entity uuids = encode(Y.Doc clientID, clock) — non-deterministic per run. The simple annotate.ts
// still leaks them (the describing layer will remove raw uuids entirely); normalize so snapshots are
// reproducible. Once the lens lands and uuids vanish from output, this becomes a no-op.
const stripIds = (s: string): string => s.replace(/"l[A-Za-z0-9_-]{14}"/g, '"<id>"');

/** Seed a fresh project (unique id ⇒ isolated DO pair) and make 3 edits, each → one co-flushed cut. */
async function scenario(pid: string) {
  const project = env.TOY_PROJECT.get(env.TOY_PROJECT.idFromName(pid));
  const log = env.TOY_LOG.get(env.TOY_LOG.idFromName(pid));
  await project.seed(pid);
  await sleep(4); // distinct cut timestamps (workerd advances the clock on I/O) for the @datetime test
  await project.renameComponent("Button", "PrimaryButton");
  await sleep(4);
  await project.setPagePath("HomePage", "/landing");
  await sleep(4);
  await project.addComponent("Card");
  await sleep(4);
  await project.addState("PrimaryButton", "count"); // Params/States/Types area: StateAdded
  await sleep(4);
  await project.renameState("PrimaryButton", "count", "clicks"); // StateRenamed (a non-fresh name set)
  return { log };
}

async function getJson(log: any, pathQuery: string): Promise<any> {
  const res = await log.fetch(new Request(`http://toy${pathQuery}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe("plexus-history mini-e2e (workerd)", () => {
  it("cumulative: a human-readable net annotation of the last 5 edits", async () => {
    const { log } = await scenario("p-cumulative");
    const body = await getJson(log, "/diff/cumulative?from=HEAD~5&to=HEAD");
    expect(body.annotation).toContain("PrimaryButton"); // the rename, humanized
    expect(body.annotation).toContain("/landing");
    expect(body.annotation).toContain("Card");
    expect(body.annotation).toContain("clicks"); // the State, humanized (Params/States/Types area)
    expect(body.annotation).not.toMatch(/"l[A-Za-z0-9_-]{14}"/); // NO raw uuids leak (the lens removed them)
    // The deliverable — the human-readable net annotation (a GitHub-action comment shape):
    expect(stripIds(body.annotation)).toMatchInlineSnapshot(`
      "Renamed component "Button" → "PrimaryButton"
      Set "HomePage" route to /landing
      Added component "Card"
      Added variable "count"
      Renamed "count" → "clicks""
    `);
  });

  it("granular: one frame per edit, each with its own change", async () => {
    const { log } = await scenario("p-granular");
    const body = await getJson(log, "/diff/granular?from=HEAD~5&to=HEAD");
    expect(body.frames).toHaveLength(5);
    const all = body.frames.map((f: any) => f.annotation).join("\n");
    expect(all).toContain("PrimaryButton");
    expect(all).toContain("Card");
    expect(all).toContain("clicks"); // the State rename, humanized
    expect(body.frames.map((f: any) => stripIds(`[cut ${f.seq}] ${f.annotation.replace(/\n/g, " · ")}`))).toMatchInlineSnapshot(`
      [
        "[cut 172] Renamed component "Button" → "PrimaryButton"",
        "[cut 173] Set "HomePage" route to /landing",
        "[cut 174] Added component "Card"",
        "[cut 175] Added variable "count"",
        "[cut 176] Renamed "count" → "clicks"",
      ]
    `);
    // each frame carries its own provenance
    for (const f of body.frames) expect(f.author).toMatchObject({ userId: "alice", kind: "human" });
  });

  it("from/to address by base64 state-vector AND @ISO-datetime, not just seq refs", async () => {
    const { log } = await scenario("p-refs");
    const cuts: JsonCut[] = await log.allCuts();
    const head = cuts[cuts.length - 1];
    const baseline = cuts[cuts.length - 6]; // the cut just before the 5 edits == HEAD~5
    const b64 = (c: JsonCut): string => btoa(JSON.stringify(c.afterState));
    const iso = (c: JsonCut): string => new Date(c.timestamp).toISOString();
    const range = (from: string, to: string): string =>
      `/diff/cumulative?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const viaSeq = await getJson(log, "/diff/cumulative?from=HEAD~5&to=HEAD");
    const viaB64 = await getJson(log, range(b64(baseline), b64(head)));
    const viaIso = await getJson(log, range(iso(baseline), iso(head)));

    // a base64 SV resolves to the exact same cut as the seq ref
    expect(viaB64.from).toBe(viaSeq.from);
    expect(viaB64.to).toBe(viaSeq.to);
    expect(viaB64.annotation).toBe(viaSeq.annotation);
    // a datetime range covers the same edits
    expect(viaIso.annotation).toContain("PrimaryButton");
  });

  it("real model edits exercise the wired areas — site flag (Project) + color token (Tokens)", async () => {
    const pid = "p-wired";
    const project = env.TOY_PROJECT.get(env.TOY_PROJECT.idFromName(pid));
    const log = env.TOY_LOG.get(env.TOY_LOG.idFromName(pid));
    await project.seed(pid);
    await sleep(4);
    await project.setSiteFlag("analytics", true); // a real @syncing.record entry (C2 key)
    await sleep(4);
    await project.addColorToken("brand-blue"); // a real ColorToken birth on the non-fresh Site
    const body = await getJson(log, "/diff/granular?from=HEAD~2&to=HEAD");
    expect(body.frames).toHaveLength(2);
    // Real model edits → real lift → the wired recognizers fire. The snapshot is the ground truth:
    expect(body.frames.map((f: any) => stripIds(f.annotation))).toMatchInlineSnapshot(`
      [
        "Changed site flag "analytics"",
        "Added color token "brand-blue"",
      ]
    `);
  });
});
