export const APP_ROUTES = Object.freeze({
  home: "/home",
  projects: "/project",
  rules: "/rule",
  work: "/work",
  knowledge: "/knowledge",
  devices: "/device",
  revisions: "/history",
  security: "/security",
  settings: "/settings",
});

export function routePath(view, id = null) {
  const base = APP_ROUTES[view];
  if (!base) throw new TypeError("Unknown app view");
  return (view === "projects" || (view === "settings" && id === "admin")) && id
    ? `${base}/${encodeURIComponent(id)}` : base;
}

function parseParts(value) {
  const [name, encodedId, ...rest] = value.replace(/^\//, "").replace(/\/$/, "").split("/");
  const view = Object.keys(APP_ROUTES).find((key) => key === name || APP_ROUTES[key] === `/${name}`);
  if (!view || rest.length || (encodedId && view !== "projects" && !(view === "settings" && encodedId === "admin"))) return null;
  let id = null;
  try {
    id = encodedId ? decodeURIComponent(encodedId) : null;
  } catch { return null; }
  if (id && (!/^[a-zA-Z0-9._-]+$/.test(id) || id === "." || id === "..")) return null;
  return { view, id, path: routePath(view, id) };
}

export function readAppRoute(location) {
  const pathname = location.pathname || "/app";
  // Keep saved hash links working, including links opened by older app tabs.
  const legacyHash = parseParts((location.hash || "").replace(/^#/, ""));
  if (legacyHash) return legacyHash;
  if (/^\/app(?:\/|$)/.test(pathname)) {
    return parseParts(pathname.replace(/^\/app\/?/, "")) || { view: "home", id: null, path: "/home" };
  }
  return parseParts(pathname);
}

export function isAppPath(pathname) {
  return /^\/app(?:\/|$)/.test(pathname) || parseParts(pathname) !== null;
}
