const menu = document.querySelector(".menu-toggle");
const nav = document.querySelector("#docs-nav");
const mobile = window.matchMedia("(max-width: 800px)");

function syncMenu() {
  menu.hidden = !mobile.matches;
  nav.hidden = mobile.matches;
  menu.setAttribute("aria-expanded", String(!nav.hidden));
  const toc = document.querySelector(".toc details");
  if (toc) toc.open = !mobile.matches;
}

syncMenu();
mobile.addEventListener("change", syncMenu);
menu.addEventListener("click", () => {
  nav.hidden = !nav.hidden;
  menu.setAttribute("aria-expanded", String(!nav.hidden));
});
nav.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobile.matches) {
    nav.hidden = true;
    menu.setAttribute("aria-expanded", "false");
    menu.focus();
  }
});

// Keep code readable and selectable even if clipboard access is unavailable.
if (navigator.clipboard && window.isSecureContext) {
  document.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    const label = document.createElement("span");
    label.textContent = code.className.match(/language-([\w-]+)/)?.[1] || "Code";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy code");
    const status = document.createElement("span");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.textContent = "Copied";
        status.textContent = "Code copied to clipboard";
      } catch {
        copy.textContent = "Select code";
        status.textContent = "Copy unavailable. Select the code and copy it manually.";
      }
      window.setTimeout(() => {
        copy.textContent = "Copy";
        status.textContent = "";
      }, 2500);
    });
    toolbar.append(label, copy, status);
    pre.before(toolbar);
    pre.classList.add("with-toolbar");
  });
}
