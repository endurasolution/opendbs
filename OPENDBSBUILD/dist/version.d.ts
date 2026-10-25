/**
 * Single source of truth for the running version: package.json next to
 * dist/, plus dist/build-info.json written by scripts/build-production.js
 * (build time and git commit, when available).
 */
export interface VersionInfo {
    name: string;
    version: string;
    builtAt: string | null;
    commit: string | null;
}
export declare const VERSION: VersionInfo;
//# sourceMappingURL=version.d.ts.map