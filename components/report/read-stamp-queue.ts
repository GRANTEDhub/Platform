"use client";

// In-flight read stamps, so an explicit mark-as-unread cannot lose a race to one.
//
// THE RACE THIS EXISTS TO CLOSE. The read stamp used to run in the page's server render, so
// it always completed before the page was interactive and nothing could race it. It now fires
// from <MarkRead>'s mount effect as a POST, which runs concurrently with whatever the user
// does next -- including clicking "Mark unread" immediately. The two requests are independent
// invocations with no ordering guarantee, and markCardRead's `.is(col, null)` filter does NOT
// save us: it was written to stop a STALE RENDER re-stamping, and if the unread write lands
// first the column really is null, so the read write matches and re-stamps. The user marked a
// row unread, navigated away, and it silently flipped back to read.
//
// So mark-unread waits for any stamp already in flight for that card before clearing. That
// forces the order the user intended -- read lands, then unread clears it -- rather than
// leaving it to latency.
const inFlight = new Map<string, Promise<unknown>>();

export function trackReadStamp(cardId: string, p: Promise<unknown>): void {
  // Always clears itself, including on rejection: a failed stamp must not leave an entry
  // that makes every later mark-unread wait out the timeout below.
  const done = p.catch(() => undefined).finally(() => {
    if (inFlight.get(cardId) === done) inFlight.delete(cardId);
  });
  inFlight.set(cardId, done);
}

// Bounded so a hung stamp cannot make the button feel broken -- the whole point of this is
// that the deliberate action wins, and a control that waits indefinitely on bookkeeping is
// worse than the race it is avoiding.
const MAX_WAIT_MS = 3000;

export async function awaitReadStamp(cardId: string): Promise<void> {
  const pending = inFlight.get(cardId);
  if (!pending) return;
  await Promise.race([pending, new Promise((r) => setTimeout(r, MAX_WAIT_MS))]);
}
