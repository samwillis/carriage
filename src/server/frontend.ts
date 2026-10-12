import { frontend } from "../../.cache/frontend";
export function serveFrontend(path: string): Response {
  const asset = frontend[path === "/oauth/connect" ? "/" : path];
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}
