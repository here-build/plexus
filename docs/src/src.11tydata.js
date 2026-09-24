export default {
  eleventyComputed: {
    permalink(data) {
      const stem = data.page.filePathStem;
      if (stem === "/index") return "/index.html";
      if (stem === "/404") return "/404.html";
      return `${stem}/index.html`;
    },
  },
};
