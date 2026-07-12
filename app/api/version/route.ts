import { NextResponse } from "next/server";

// Public deploy-version probe: which commit is THIS build? Lets anyone confirm in
// 5 seconds that production actually advanced to the latest main -- the guard for
// the silent-rollback failure mode (an Instant Rollback pins production and stops
// auto-promoting, with no other visible signal). Compare `commit` here to main's
// HEAD; a mismatch after a merge means production isn't tracking main.
//
// Public + unauthenticated ON PURPOSE: it must work when you're not logged in and
// even if auth itself is what's broken. Disclosure is non-sensitive (a commit SHA
// of a private repo, the branch, the env).
//
// force-dynamic + no-store are load-bearing: a cached version response would report
// a stale SHA and defeat the entire purpose. Never let this be cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return NextResponse.json(
    {
      commit,
      shortCommit: commit ? commit.slice(0, 7) : null,
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      env: process.env.VERCEL_ENV ?? "development",
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
    { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } },
  );
}
