import type { Meta, StoryObj } from "@storybook/react";

import { DualIframeBridge } from "../components/DualIframeBridge.js";

const meta = {
  title: "PlexusText/Lexical",
  component: DualIframeBridge,
  parameters: { layout: "fullscreen" },
  args: { editor: "lexical" as const },
} satisfies Meta<typeof DualIframeBridge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two iframes with Lexical + format + awareness HUD. Peers use projector: "auto" (P1 Y.Array). */
export const CrossIframeSync: Story = {
  args: {
    editor: "lexical",
    seedText:
      "Lexical peers over a local Plexus bridge (P1 auto projector).\n\nTry bold (⌘/Ctrl-B) and italic — formats ride markers in the entity sequence. Remote carets list bottom-right.",
    leftUser: { name: "Ada", color: "#30bced" },
    rightUser: { name: "Gus", color: "#ec368d" },
    height: "80vh",
  },
};

export const EmptyStart: Story = {
  args: {
    editor: "lexical",
    seedText: "",
    leftUser: { name: "Left", color: "#4ecdc4" },
    rightUser: { name: "Right", color: "#ff6b6b" },
  },
};
