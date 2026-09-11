export function isPeerView(search: string): boolean {
  return new URLSearchParams(search).get("view") === "peer";
}

export function hrefWithView(href: string, view: string | null): string {
  const url = new URL(href);
  if (view) url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  return url.toString();
}
