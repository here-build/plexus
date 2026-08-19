import type { Meta, StoryObj } from "@storybook/react";

import { DualIframeBridge } from "../components/DualIframeBridge.js";

const meta = {
  title: "PlexusText/CodeMirror",
  component: DualIframeBridge,
  parameters: { layout: "fullscreen" },
  args: { editor: "cm" as const },
} satisfies Meta<typeof DualIframeBridge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two iframes, one MessageChannel, live CRDT + caret awareness. Peers use projector: "auto" (P1 Y.Array). */
export const CrossIframeSync: Story = {
  args: {
    editor: "cm",
    seedText:
      "CodeMirror peers over a local Plexus bridge (P1 auto projector).\n\nType on the left — watch the right. Move the caret for remote carets.",
    leftUser: { name: "Ada", color: "#30bced" },
    rightUser: { name: "Gus", color: "#6eeb83" },
    height: "80vh",
  },
};

export const EmptyStart: Story = {
  args: {
    editor: "cm",
    seedText: "",
    leftUser: { name: "Left", color: "#ffbc42" },
    rightUser: { name: "Right", color: "#a06cd5" },
  },
};
