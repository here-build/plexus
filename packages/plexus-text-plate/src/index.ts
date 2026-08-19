/**
 * `@here.build/plexus-text-plate` — thin Plate-facing API over the Slate membrane.
 *
 * Plate (Udecode) is UX/plugins over Slate. A Plate editor **is** a Slate `Editor`.
 * The CRDT binding, textDiff range ops, awareness, and liminality live in
 * `@here.build/plexus-text-slate`. This package does not invent a second collab
 * tree and does not reimplement textDiff.
 *
 * Membrane law: docs/working-proposals/plexustext-editor-membrane.md
 */

import type { PlexusText } from "@here.build/plexus-text";
import {
  bindSlate,
  createSlateBoundEditor,
  getRemoteSelections,
  withLiminalGesture,
  type BindSlateOptions,
  type RemoteSelection,
  type SlateDescendant,
  type SlateParagraph,
  type SlateText,
} from "@here.build/plexus-text-slate";
import type { Editor } from "slate";
import * as Y from "yjs";

export type {
  BindSlateOptions,
  RemoteSelection,
  SlateDescendant,
  SlateParagraph,
  SlateText,
};
export { bindSlate, createSlateBoundEditor, getRemoteSelections, withLiminalGesture };

export type BindPlateOptions = BindSlateOptions;

/**
 * Two-way-bind a Plate (or any Slate) editor to a PlexusText.
 * Thin alias of `bindSlate` — Plate editors ARE Slate Editors.
 */
export function bindPlate(
  editor: Editor,
  text: PlexusText,
  docOrOpts: Y.Doc | BindPlateOptions,
): () => void {
  return bindSlate(editor, text, docOrOpts);
}

/**
 * Create a Slate editor suitable for Plate + PlexusText collab (history-enabled).
 *
 * Pure Slate + slate-history — does **not** require `@udecode/plate*` packages.
 * Works with any Plate editor that is a Slate `Editor` (pass your own
 * `createPlateEditor()` result into `bindPlate` instead if you already have one).
 *
 * v1 note: we intentionally stay off heavy Plate package versions that fight
 * the monorepo pin; the membrane only needs the Slate surface.
 */
export function createPlateBoundEditor(): Editor {
  return createSlateBoundEditor();
}
