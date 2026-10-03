/**
 * DigiBot exposes one download Mini App with an explicit, immutable namespace.
 * Keep the route table deliberately small and exact: caller-controlled names
 * and path prefixes never select an app.
 */

export const DOWNLOADER_MINI_APP_ID = "downloader" as const;
export const DOWNLOADER_MINI_APP_PATH = "/apps/downloader" as const;
/** SHA-256 prefixes; update each token whenever its static asset changes. */
export const DOWNLOADER_MINI_APP_CSS_VERSION = "0e93d961" as const;
export const DOWNLOADER_MINI_APP_JS_VERSION = "910bc897" as const;
export const DOWNLOADER_MINI_APP_CSS_PATH = `${DOWNLOADER_MINI_APP_PATH}/assets/${DOWNLOADER_MINI_APP_CSS_VERSION}/mini-app.${DOWNLOADER_MINI_APP_CSS_VERSION}.css` as const;
export const DOWNLOADER_MINI_APP_JS_PATH = `${DOWNLOADER_MINI_APP_PATH}/assets/${DOWNLOADER_MINI_APP_JS_VERSION}/mini-app.${DOWNLOADER_MINI_APP_JS_VERSION}.js` as const;
export const DOWNLOADER_MINI_APP_API_PATH = "/api/apps/downloader" as const;

export type MiniAppId = typeof DOWNLOADER_MINI_APP_ID;
export type MiniAppAuthenticationPolicy = "none" | "telegram-init-data";
export type MiniAppAuthorizationPolicy = "downloader-owner";
export type DownloaderApiEndpoint = "sources" | "history" | "history-item";
export type MiniAppApiEndpoint = DownloaderApiEndpoint | "diagnostics";
export type MiniAppRouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export function isDownloaderApiEndpoint(value: MiniAppApiEndpoint): value is DownloaderApiEndpoint {
  return ["sources", "history", "history-item"].includes(value);
}

/**
 * App ownership is explicit even while only the downloader is registered.
 * A future app must declare different data/object namespaces and add its own
 * authorization policy before it can enter the runtime registry.
 */
export interface MiniAppDefinition {
  readonly id: string;
  readonly path: string;
  readonly cssPath: string;
  readonly jsPath: string;
  readonly apiPath: string;
  readonly authenticationPolicy: Exclude<MiniAppAuthenticationPolicy, "none">;
  readonly authorizationPolicy: MiniAppAuthorizationPolicy;
  readonly d1Namespace: string;
  readonly r2Namespace: string | null;
  readonly configurationPolicy: "worker-bindings-only";
  readonly backgroundWorkPolicy: "download-recovery-and-retention";
  readonly observabilityName: string;
}

const DOWNLOADER_MINI_APP_DEFINITION = {
  id: DOWNLOADER_MINI_APP_ID,
  path: DOWNLOADER_MINI_APP_PATH,
  cssPath: DOWNLOADER_MINI_APP_CSS_PATH,
  jsPath: DOWNLOADER_MINI_APP_JS_PATH,
  apiPath: DOWNLOADER_MINI_APP_API_PATH,
  authenticationPolicy: "telegram-init-data",
  authorizationPolicy: "downloader-owner",
  d1Namespace: "jobs",
  r2Namespace: "jobs/",
  configurationPolicy: "worker-bindings-only",
  backgroundWorkPolicy: "download-recovery-and-retention",
  observabilityName: "digibot.downloader",
} as const satisfies MiniAppDefinition;

/** Build and freeze a registry while rejecting route, ID, and storage collisions. */
export function buildMiniAppRegistry(
  definitions: readonly MiniAppDefinition[],
): Readonly<Record<string, MiniAppDefinition>> {
  const registry: Record<string, MiniAppDefinition> = Object.create(null) as Record<string, MiniAppDefinition>;
  const ids = new Set<string>();
  const routes = new Set<string>();
  const d1Namespaces = new Set<string>();
  const r2Namespaces = new Set<string>();
  const observabilityNames = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate Mini App id: ${definition.id}`);
    ids.add(definition.id);
    for (const [field, value] of [
      ["path", definition.path],
      ["cssPath", definition.cssPath],
      ["jsPath", definition.jsPath],
      ["apiPath", definition.apiPath],
    ] as const) {
      if (routes.has(value)) throw new Error(`Duplicate Mini App route or asset (${field}): ${value}`);
      routes.add(value);
    }
    if (d1Namespaces.has(definition.d1Namespace)) throw new Error(`Duplicate Mini App d1Namespace: ${definition.d1Namespace}`);
    if (definition.r2Namespace !== null && r2Namespaces.has(definition.r2Namespace)) {
      throw new Error(`Duplicate Mini App r2Namespace: ${definition.r2Namespace}`);
    }
    if (observabilityNames.has(definition.observabilityName)) throw new Error(`Duplicate Mini App observabilityName: ${definition.observabilityName}`);
    d1Namespaces.add(definition.d1Namespace);
    if (definition.r2Namespace !== null) r2Namespaces.add(definition.r2Namespace);
    observabilityNames.add(definition.observabilityName);
    registry[definition.id] = Object.freeze({ ...definition });
  }
  return Object.freeze(registry);
}

export const MINI_APP_REGISTRY = buildMiniAppRegistry([DOWNLOADER_MINI_APP_DEFINITION]) as Readonly<
  Record<MiniAppId, MiniAppDefinition>
>;

interface MiniAppRouteBase {
  readonly app: MiniAppDefinition;
  readonly legacy: boolean;
  readonly methods: readonly MiniAppRouteMethod[];
  readonly authenticationPolicy: MiniAppAuthenticationPolicy;
}

export type MiniAppRoute =
  | (MiniAppRouteBase & { readonly kind: "html" })
  | (MiniAppRouteBase & { readonly kind: "asset"; readonly asset: "css" | "js" })
  | (MiniAppRouteBase & { readonly kind: "api"; readonly endpoint: MiniAppApiEndpoint; readonly resourceId?: string });

const PUBLIC_METHODS = Object.freeze(["GET", "HEAD"] as const);
const READ_API_METHODS = Object.freeze(["GET"] as const);
const HISTORY_API_METHODS = Object.freeze(["GET", "DELETE"] as const);
const DELETE_API_METHODS = Object.freeze(["DELETE"] as const);

/** Build an immutable exact-path table and fail closed on any collision. */
export function buildExactMiniAppRouteTable(
  entries: readonly (readonly [string, MiniAppRoute])[],
): Readonly<Record<string, MiniAppRoute>> {
  const table: Record<string, MiniAppRoute> = Object.create(null) as Record<string, MiniAppRoute>;
  for (const [path, route] of entries) {
    if (Object.hasOwn(table, path)) throw new Error(`Duplicate Mini App route: ${path}`);
    table[path] = Object.freeze({ ...route, methods: Object.freeze([...route.methods]) });
  }
  return Object.freeze(table);
}

const downloader = MINI_APP_REGISTRY[DOWNLOADER_MINI_APP_ID];
const HISTORY_ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:%-]{0,255}$/u;

function isHistoryItemPath(pathname: string, prefix: string): boolean {
  const suffix = pathname.slice(prefix.length);
  return suffix.length > 0
    && !/%(?:2f|5c)/iu.test(suffix)
    && HISTORY_ROUTE_SEGMENT.test(suffix);
}

export const MINI_APP_ROUTE_TABLE = buildExactMiniAppRouteTable([
  ["/mini-app", { kind: "html", app: downloader, legacy: true, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  ["/mini-app.css", { kind: "asset", app: downloader, asset: "css", legacy: true, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  ["/mini-app.js", { kind: "asset", app: downloader, asset: "js", legacy: true, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  [downloader.path, { kind: "html", app: downloader, legacy: false, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  [downloader.cssPath, { kind: "asset", app: downloader, asset: "css", legacy: false, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  [downloader.jsPath, { kind: "asset", app: downloader, asset: "js", legacy: false, methods: PUBLIC_METHODS, authenticationPolicy: "none" }],
  ["/api/sources", { kind: "api", app: downloader, endpoint: "sources", legacy: true, methods: READ_API_METHODS, authenticationPolicy: downloader.authenticationPolicy }],
  ["/api/history", { kind: "api", app: downloader, endpoint: "history", legacy: true, methods: HISTORY_API_METHODS, authenticationPolicy: downloader.authenticationPolicy }],
  [`${downloader.apiPath}/sources`, { kind: "api", app: downloader, endpoint: "sources", legacy: false, methods: READ_API_METHODS, authenticationPolicy: downloader.authenticationPolicy }],
  [`${downloader.apiPath}/history`, { kind: "api", app: downloader, endpoint: "history", legacy: false, methods: HISTORY_API_METHODS, authenticationPolicy: downloader.authenticationPolicy }],
  [`${downloader.apiPath}/diagnostics`, { kind: "api", app: downloader, endpoint: "diagnostics", legacy: false, methods: READ_API_METHODS, authenticationPolicy: downloader.authenticationPolicy }],
]);

const LEGACY_HISTORY_ITEM_ROUTE = Object.freeze({
    kind: "api",
    app: downloader,
    endpoint: "history-item",
    legacy: true,
    methods: DELETE_API_METHODS,
    authenticationPolicy: downloader.authenticationPolicy,
  } as const satisfies MiniAppRoute);
const CANONICAL_HISTORY_ITEM_ROUTE = Object.freeze({
  ...LEGACY_HISTORY_ITEM_ROUTE,
  legacy: false,
} as const satisfies MiniAppRoute);

export function miniAppRouteAllowsMethod(route: MiniAppRoute, method: string): boolean {
  return (route.methods as readonly string[]).includes(method);
}

/** Resolve only registered, canonical or intentionally retained legacy paths. */
export function resolveMiniAppRoute(pathname: string): MiniAppRoute | null {
  const exact = MINI_APP_ROUTE_TABLE[pathname];
  if (exact) return exact;
  if (pathname.startsWith("/api/history/") && isHistoryItemPath(pathname, "/api/history/")) {
    return LEGACY_HISTORY_ITEM_ROUTE;
  }
  if (pathname.startsWith(`${downloader.apiPath}/history/`)
    && isHistoryItemPath(pathname, `${downloader.apiPath}/history/`)) {
    return CANONICAL_HISTORY_ITEM_ROUTE;
  }
  return null;
}
