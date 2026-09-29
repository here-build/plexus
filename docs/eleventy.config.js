import { HtmlBasePlugin } from "@11ty/eleventy";
import hljs from "highlight.js";

const PATH_PREFIX = "/";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy({ public: "." });
  eleventyConfig.addPassthroughCopy({ css: "css", js: "js" });
  eleventyConfig.addPassthroughCopy({
    "../packages/plexus/i-cant-believe-its-not-local.png": "hero.png",
  });
  eleventyConfig.addGlobalData("layout", "layout.njk");
  eleventyConfig.addGlobalData("siteTitle", "Plexus");
  eleventyConfig.setServerOptions({ port: 4321 });

  eleventyConfig.addFilter("pageContext", (nav, url) => {
    for (const section of nav) {
      const items = section.items || [section];
      const index = items.findIndex((item) => item.href === url);
      if (index >= 0) return {
        section: section.items ? section.label : "",
        previous: items[index - 1],
        next: items[index + 1],
      };
    }
    return {};
  });
  eleventyConfig.addFilter("headings", (html) => [...html.matchAll(/<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => ({
    level: match[1],
    id: match[2],
    label: match[3].replace(/<a class="heading-anchor"[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, ""),
  })));

  eleventyConfig.amendLibrary("md", (md) => {
    md.set({
      html: true,
      linkify: true,
      typographer: false,
      highlight(code, language) {
        return language && hljs.getLanguage(language)
          ? hljs.highlight(code, { language, ignoreIllegals: true }).value
          : "";
      },
    });
    // Match the existing GitHub-style fragment links, including doubled hyphens.
    md.core.ruler.push("heading_ids", (state) => {
      const used = new Set(["main", "docs-nav"]);
      for (let index = 0; index < state.tokens.length; index++) {
        const token = state.tokens[index];
        if (token.type !== "heading_open") continue;
        const inline = state.tokens[index + 1];
        const title = (inline.children || []).map((child) =>
          ["text", "code_inline"].includes(child.type) ? child.content : ""
        ).join("");
        const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
        let id = base;
        for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
        used.add(id);
        token.attrSet("id", id);
        const anchor = new state.Token("html_inline", "", 0);
        anchor.content = ` <a class="heading-anchor" href="#${id}" aria-label="Link to ${md.utils.escapeHtml(title)}">#</a>`;
        inline.children.push(anchor);
      }
    });
    md.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table>\n';
    md.renderer.rules.table_close = () => '</table></div>\n';
  });

  return {
    pathPrefix: PATH_PREFIX,
    dir: { input: "src", output: "dist", includes: "_includes", data: "_data" },
    markdownTemplateEngine: false,
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
}
