/** Types for scripts/release-notes.mjs, so TypeScript tests can import it. */
export const NEUTRAL_NOTE: string;
export function releaseNotes(changelog: string, version: string, allowNeutral: boolean): string;
export function isPatch(version: string): boolean;
