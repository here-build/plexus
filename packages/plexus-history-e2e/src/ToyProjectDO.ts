import { DurableObject } from "cloudflare:workers";
import { ColorToken, PageComponent, PageMeta, PlainComponent, ProjectPackage, Site, State, TextType, TplTag } from "@here.build/model";
import { bindCapture, serializeCut, type JsonCut } from "@here.build/plexus-history/capture";
import { ProjectPlexus } from "@here.build/project-plexus";
import * as Y from "yjs";

import type { Env } from "./env.js";

/**
 * Toy collaboration leader. Holds the live Plexus doc, wires `bindCapture` (the thing the real
 * ProjectCollaborationDO still lacks until the capture server-pass), and co-flushes the struct
 * diff + the grounded cuts to {@link ToyLogDO}. Each mutation RPC = one transaction = one cut.
 */
export class ToyProjectDO extends DurableObject<Env> {
  private readonly doc = new Y.Doc();
  private plexus?: ProjectPlexus;
  private buffered: JsonCut[] = [];
  private lastLogSV = new Uint8Array();
  private projectId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    bindCapture(this.doc, {
      clientIdToUserSession: () => ({ userId: "alice", kind: "human" }),
      originToUserSession: () => ({ userId: "alice", kind: "human" }),
      onCut: (cut) => {
        this.buffered.push(serializeCut(cut));
      },
    });
  }

  async seed(projectId: string): Promise<void> {
    this.projectId = projectId;
    const button = new PlainComponent({ name: "Button", tplTree: new TplTag({ tag: "button", name: "root", locked: false }) });
    const home = new PageComponent({
      name: "HomePage",
      tplTree: new TplTag({ tag: "div", name: "root", locked: false }),
      pageMeta: new PageMeta({ path: "/", title: "Home", description: "Home" }),
    });
    const site = new Site({ components: [button, home] });
    this.plexus = ProjectPlexus.bootstrap(
      new ProjectPackage({ site, projectId: projectId as never, name: "toy", version: "0.0.0" }),
      "doc",
      this.doc,
    );
    await this.flush();
  }

  async renameComponent(oldName: string, newName: string): Promise<void> {
    this.plexus!.transact(() => {
      const c = this.components().find((x) => x.name === oldName);
      if (c) c.name = newName;
    });
    await this.flush();
  }

  async setPagePath(pageName: string, path: string): Promise<void> {
    this.plexus!.transact(() => {
      const c = this.components().find((x) => x.name === pageName);
      if (c instanceof PageComponent) c.pageMeta.path = path;
    });
    await this.flush();
  }

  async addComponent(name: string): Promise<void> {
    this.plexus!.transact(() => {
      this.components().push(new PlainComponent({ name, tplTree: new TplTag({ tag: "div", name: "root", locked: false }) }));
    });
    await this.flush();
  }

  /** Add a (text-typed) State to a component — exercises the Params/States/Types area (StateAdded). */
  async addState(componentName: string, stateName: string): Promise<void> {
    this.plexus!.transact(() => {
      const c = this.components().find((x) => x.name === componentName);
      if (c) c.states.push(new State({ name: stateName, type: new TextType({}) }));
    });
    await this.flush();
  }

  /** Rename a State on a component — exercises StateRenamed (a non-fresh `name` set). */
  async renameState(componentName: string, oldName: string, newName: string): Promise<void> {
    this.plexus!.transact(() => {
      const c = this.components().find((x) => x.name === componentName);
      const s = c?.states.find((x) => x.name === oldName);
      if (s) s.name = newName;
    });
    await this.flush();
  }

  /** Toggle a site flag — Project area SiteConfigChanged via a real @syncing.record entry (the C2 entry key). */
  async setSiteFlag(name: string, value: boolean): Promise<void> {
    this.plexus!.transact(() => {
      this.plexus!.root.site.flags[name] = value;
    });
    await this.flush();
  }

  /** Add a color token — Tokens area TokenCreated (a real birth on the non-fresh Site, not absorbed). */
  async addColorToken(name: string): Promise<void> {
    this.plexus!.transact(() => {
      this.plexus!.root.site.colorTokens.push(new ColorToken({ name }));
    });
    await this.flush();
  }

  private components(): Site["components"] {
    return this.plexus!.root.site.components;
  }

  /** Co-flush: ship the new structs + the cuts grounded in them to the archive DO together. */
  private async flush(): Promise<void> {
    const diff = this.lastLogSV.byteLength === 0 ? Y.encodeStateAsUpdate(this.doc) : Y.encodeStateAsUpdate(this.doc, this.lastLogSV);
    const cuts = this.buffered;
    this.buffered = [];
    const log = this.env.TOY_LOG.get(this.env.TOY_LOG.idFromName(this.projectId));
    await log.applyDiffAndCuts(diff, cuts);
    this.lastLogSV = Y.encodeStateVector(this.doc);
  }
}
