import retired from "./fixtures/retired-news-routes.json";
import { MINI_APP_ROUTE_TABLE } from "../apps/cloudflare-worker/src/mini-app-router";

/** Route contract checked by the local router tests. */
export const RELEASE_ROUTES = [
  ...retired.routes.flatMap(({ path, methods }) => methods.map((method) => ({ path, method, status: 404 }))),
  ...["PATCH", "DELETE"].map((method) => ({ path: "/api/apps/news/sources/release-probe", method, status: 404 })),
  ...Object.entries(MINI_APP_ROUTE_TABLE).flatMap(([path, route]) =>
    route.methods.map((method) => ({ path, method, status: route.kind === "api" ? 401 : 200 }))),
];

export async function checkReleaseRoutes(fetchRoute: (path: string, method: string) => Promise<Response>): Promise<void> {
  for (const { path, method, status } of RELEASE_ROUTES) {
    const response = await fetchRoute(path, method);
    await response.body?.cancel();
    if (response.status !== status) throw new Error(`${method} ${path}: expected ${status}, received ${response.status}`);
  }
}
