import { Fragment } from "react";
import { titleParts } from "@/lib/report/title";

// The distinctive word italic-orange — the one shared title treatment for the client-facing
// grant surfaces (the alert card hero and the grant report main box), so the two cannot drift
// (they had inlined the same map twice). Renders INLINE fragments only: the caller owns the
// wrapping heading element and any trailing-acronym de-emphasis (see GrantTitle).
export function EmphasizedTitle({ text }: { text: string }) {
  return (
    <>
      {titleParts(text).map((p, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          {p.em ? <em className="italic text-brand-orange">{p.text}</em> : p.text}
        </Fragment>
      ))}
    </>
  );
}
