/**
 * POSIX path plumbing for the VFS. iso-git always speaks `/`-separated paths and
 * frequently passes leading-slash absolutes ("/index.js") relative to the `dir`
 * it was given. The store is a tree rooted at the `PlexusFS`, so a path is just
 * the list of segments to walk; this module turns a path string into that list
 * (resolving `.`/`..` and collapsing empties) and back.
 */

/**
 * Split a path into clean segments, resolving `.` and `..` and dropping empty
 * segments (leading slash, double slash, trailing slash). The result is always
 * relative to the FS root — an absolute "/a/b" and a relative "a/b" both yield
 * `["a", "b"]`, which is what we want since the root is the only anchor.
 */
export function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** Join segments with POSIX `/`. */
export function joinPath(segments: readonly string[]): string {
  return segments.join("/");
}

/** The last segment of a path (basename), or "" for the root. */
export function basename(path: string): string {
  return splitPath(path).at(-1) ?? "";
}

/** Everything but the last segment, as a normalized relative path ("" for root-level). */
export function dirname(path: string): string {
  const segs = splitPath(path);
  segs.pop();
  return joinPath(segs);
}
