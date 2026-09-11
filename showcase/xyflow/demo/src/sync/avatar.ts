import Avatar from "boring-avatars";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const cache = new Map<string, string>();

export function boringAvatar(seed: string, colors?: string[]): string {
  const key = colors ? `${seed}:${colors.join(",")}` : seed;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const svg = renderToStaticMarkup(
    createElement(Avatar, {
      name: seed,
      size: 20,
      variant: "beam",
      title: false,
      ...(colors ? { colors } : {}),
    }),
  );
  cache.set(key, svg);
  return svg;
}
