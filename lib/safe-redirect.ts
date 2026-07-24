// Restrict post-auth redirects to same-origin relative paths. The `next` param
// arrives from the query string, so a protocol-relative value ("//evil.com" or
// "/\evil.com") must not slip through and turn `${origin}${next}` into an
// off-origin redirect. Anything that isn't a plain single-slash path falls back
// to "/".
export function safeNextPath(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    return raw;
  }
  return "/";
}
