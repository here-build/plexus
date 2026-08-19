import { Annotation, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Plexus, PlexusAwareness } from "@here.build/plexus";
import {
  colorForClientId,
  type EditorUser,
  lightColor,
  type PlexusText,
  type SelectionPresence,
  type TextPresence,
} from "@here.build/plexus-text";

/**
 * Remote selection / caret decorations + local selection publish over PlexusAwareness.
 * Offsets are code-unit positions in the plain `toText` projection.
 */

const remoteSelectionsAnnotation = Annotation.define<null>();

class RemoteCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-plexusSelectionCaret";
    caret.style.borderColor = this.color;
    caret.style.backgroundColor = this.color;

    const dot = document.createElement("div");
    dot.className = "cm-plexusSelectionCaretDot";
    caret.appendChild(dot);

    const info = document.createElement("div");
    info.className = "cm-plexusSelectionInfo";
    info.textContent = this.name;
    caret.appendChild(info);

    return caret;
  }

  eq(other: RemoteCaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const remoteSelectionsTheme = EditorView.baseTheme({
  ".cm-plexusSelection": {},
  ".cm-plexusLineSelection": {
    padding: "0",
    margin: "0px 2px 0px 4px",
  },
  ".cm-plexusSelectionCaret": {
    position: "relative",
    borderLeft: "1px solid black",
    borderRight: "1px solid black",
    marginLeft: "-1px",
    marginRight: "-1px",
    boxSizing: "border-box",
    display: "inline",
  },
  ".cm-plexusSelectionCaretDot": {
    borderRadius: "50%",
    position: "absolute",
    width: ".4em",
    height: ".4em",
    top: "-.2em",
    left: "-.2em",
    backgroundColor: "inherit",
    transition: "transform .3s ease-in-out",
    boxSizing: "border-box",
  },
  ".cm-plexusSelectionCaret:hover > .cm-plexusSelectionCaretDot": {
    transformOrigin: "bottom center",
    transform: "scale(0)",
  },
  ".cm-plexusSelectionInfo": {
    position: "absolute",
    top: "-1.05em",
    left: "-1px",
    fontSize: ".75em",
    fontFamily: "serif",
    fontStyle: "normal",
    fontWeight: "normal",
    lineHeight: "normal",
    userSelect: "none",
    color: "white",
    paddingLeft: "2px",
    paddingRight: "2px",
    zIndex: "101",
    transition: "opacity .3s ease-in-out",
    backgroundColor: "inherit",
    opacity: "0",
    whiteSpace: "nowrap",
  },
  ".cm-plexusSelectionCaret:hover > .cm-plexusSelectionInfo": {
    opacity: "1",
  },
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export type AwarenessExtensionOpts = {
  awareness: PlexusAwareness;
  user?: EditorUser;
  localClientId?: number;
};

/** Publish local selection + render remote carets. */
export function plexusTextAwareness(opts: AwarenessExtensionOpts): Extension {
  const { awareness, user } = opts;
  const localId = opts.localClientId ?? awareness.doc.clientID;

  if (user) {
    awareness.setField("user" as never, user as never);
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private readonly onAwareness: () => void;

      constructor(view: EditorView) {
        // Defer dispatch — setField during update() emits "change" synchronously;
        // CM forbids nested update/dispatch.
        this.onAwareness = () => {
          queueMicrotask(() => {
            try {
              view.dispatch({ annotations: remoteSelectionsAnnotation.of(null) });
            } catch {
              /* view destroyed */
            }
          });
        };
        awareness.on("change", this.onAwareness);
        this.decorations = this.build(view);
      }

      destroy() {
        awareness.off("change", this.onAwareness);
      }

      update(u: ViewUpdate) {
        // Publish selection whenever it changes. Focus checks are unreliable in jsdom /
        // headless; collaborators still need live carets during active editing sessions.
        if (u.selectionSet || u.focusChanged) {
          const hasFocus = u.view.hasFocus;
          const prev =
            (awareness.getField("selection" as never) as SelectionPresence | null | undefined) ?? null;
          if (hasFocus || u.selectionSet) {
            const sel = u.state.selection.main;
            const next: SelectionPresence = { anchor: sel.anchor, head: sel.head };
            if (!prev || prev.anchor !== next.anchor || prev.head !== next.head) {
              awareness.setField("selection" as never, next as never);
            }
          } else if (prev != null) {
            awareness.clearField("selection" as never);
          }
        }

        if (
          u.docChanged ||
          u.selectionSet ||
          u.transactions.some((t) => t.annotation(remoteSelectionsAnnotation) !== undefined)
        ) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const len = view.state.doc.length;
        type Range = { from: number; to: number; deco: Decoration };
        const ranges: Range[] = [];

        for (const peerId of awareness.getPeerIds()) {
          if (peerId === localId) continue;
          const peer = awareness.getPeer(peerId) as TextPresence | null;
          if (!peer?.selection) continue;
          const { anchor, head } = peer.selection;
          const a = clamp(anchor, 0, len);
          const h = clamp(head, 0, len);
          const start = Math.min(a, h);
          const end = Math.max(a, h);
          const color = peer.user?.color ?? colorForClientId(peerId);
          const name = peer.user?.name ?? `User ${peerId}`;
          const soft = lightColor(color);

          if (start !== end) {
            const startLine = view.state.doc.lineAt(start);
            const endLine = view.state.doc.lineAt(end);
            if (startLine.number === endLine.number) {
              ranges.push({
                from: start,
                to: end,
                deco: Decoration.mark({
                  attributes: { style: `background-color: ${soft}` },
                  class: "cm-plexusSelection",
                }),
              });
            } else {
              ranges.push({
                from: start,
                to: startLine.to,
                deco: Decoration.mark({
                  attributes: { style: `background-color: ${soft}` },
                  class: "cm-plexusSelection",
                }),
              });
              ranges.push({
                from: endLine.from,
                to: end,
                deco: Decoration.mark({
                  attributes: { style: `background-color: ${soft}` },
                  class: "cm-plexusSelection",
                }),
              });
              for (let ln = startLine.number + 1; ln < endLine.number; ln++) {
                const line = view.state.doc.line(ln);
                ranges.push({
                  from: line.from,
                  to: line.from,
                  deco: Decoration.line({
                    attributes: { style: `background-color: ${soft}`, class: "cm-plexusLineSelection" },
                  }),
                });
              }
            }
          }

          ranges.push({
            from: h,
            to: h,
            deco: Decoration.widget({
              side: h - a > 0 ? -1 : 1,
              widget: new RemoteCaretWidget(color, name),
            }),
          });
        }

        ranges.sort((x, y) => x.from - y.from || x.to - y.to);
        for (const r of ranges) builder.add(r.from, r.to, r.deco);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [remoteSelectionsTheme, plugin];
}

/** After Plexus applies peer liminal previews, re-project model → editor. */
export function liminalRerender(onRerender: () => void, plexus: Plexus<PlexusText>): () => void {
  const aw = plexus.awareness;
  const handler = (): void => {
    // Defer so we never dispatch/update while CM is mid-update (awareness setField
    // re-enters from the same editor tick).
    queueMicrotask(() => {
      try {
        onRerender();
      } catch {
        /* view destroyed */
      }
    });
  };
  aw.on("change", handler);
  return () => aw.off("change", handler);
}
