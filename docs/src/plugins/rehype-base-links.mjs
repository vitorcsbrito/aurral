// Markdown links are written root-relative (/getting-started/storage/).
// Astro does not rewrite them, so they 404 when the site has a base path.
export function rehypeBaseLinks({ base = "/" } = {}) {
  const prefix = base.replace(/\/+$/, "");
  if (!prefix) return () => {};

  const rewrite = (value) => {
    if (typeof value !== "string") return value;
    // Protocol-relative and absolute URLs belong to another origin.
    if (!value.startsWith("/") || value.startsWith("//")) return value;
    if (value === prefix || value.startsWith(`${prefix}/`)) return value;
    return `${prefix}${value}`;
  };

  const visit = (node) => {
    if (node.type === "element") {
      if (node.tagName === "a") {
        node.properties.href = rewrite(node.properties?.href);
      } else if (node.tagName === "img") {
        node.properties.src = rewrite(node.properties?.src);
      }
    }
    for (const child of node.children || []) visit(child);
  };

  return (tree) => visit(tree);
}
