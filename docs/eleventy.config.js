import { HtmlBasePlugin } from "@11ty/eleventy";

const PATH_PREFIX = "/plexus/";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy({ public: "." });
  eleventyConfig.addPassthroughCopy({ css: "css" });
  eleventyConfig.addPassthroughCopy({
    "../packages/plexus/i-cant-believe-its-not-local.png": "hero.png",
  });

  eleventyConfig.addGlobalData("layout", "layout.njk");
  eleventyConfig.addGlobalData("siteTitle", "Plexus");

  eleventyConfig.setServerOptions({
    port: 4321,
  });

  eleventyConfig.amendLibrary("md", (md) => {
    md.set({ html: true, linkify: true, typographer: false });
  });

  return {
    pathPrefix: PATH_PREFIX,
    dir: {
      input: "src",
      output: "dist",
      includes: "_includes",
      data: "_data",
    },
    markdownTemplateEngine: false,
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
}
