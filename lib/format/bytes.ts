// Human-readable byte size for a file-size label (attachments, uploads).
//
// CLIENT-SAFE AND DEPENDENCY-FREE ON PURPOSE. It is shared by a "use client" component
// (components/intellengine/submission-package.tsx) AND the server-side export assembler
// (lib/intellengine/export.ts). export.ts transitively pulls the Anthropic SDK, so the two
// cannot share this from there without dragging that bundle into the client -- hence its own
// leaf module with no imports.
//
// Empty string for null/zero so a missing size renders as nothing rather than "0 B".
export function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
