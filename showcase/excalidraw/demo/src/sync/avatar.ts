/**
 * App-side avatar strategy — the demonstration that `getAvatar` is a slot.
 *
 * `ExcalidrawAwareness` ships a dependency-free default so it can be imported
 * in a Worker or a vanilla host. This app wants nicer faces, so it pays for
 * `boring-avatars` and `react-dom/server` itself and overrides the method on
 * {@link DemoAwareness}. That is the whole override protocol.
 */

import Avatar from "boring-avatars";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const cache = new Map<string, string>();

/** Beam SVG for an identity key. Cached — the seed never changes. */
export function boringAvatar(seed: string): string {
  const hit = cache.get(seed);
  if (hit !== undefined) return hit;
  const svg = renderToStaticMarkup(
    createElement(Avatar, {
      name: seed,
      size: 20,
      variant: "beam",
      title: false,
    }),
  );
  cache.set(seed, svg);
  return svg;
}
