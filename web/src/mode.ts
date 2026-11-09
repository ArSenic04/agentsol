/**
 * Who serves this page. The build ships "static" (what any static host serves). The local
 * read-only bridge replaces this one module with "local-bridge" when it has a workspace, so
 * a static copy never probes /api at all. The workspace view still verifies the bridge
 * through /api/health before showing data.
 */
export type ServedBy = "static" | "local-bridge";
export const SERVED_BY: ServedBy = "static";
