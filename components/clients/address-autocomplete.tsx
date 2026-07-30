"use client";

import { useEffect, useRef, useState } from "react";
import { Input, Label } from "@/components/ui/input";

// Google-Maps-style address autocomplete, as ONE "Address" line: type, pick a
// suggestion, and the parts (street / city / county / state / ZIP) are filled into
// HIDDEN inputs behind it. The admin sees one clean field; the server action still
// receives the same five field names, unchanged.
//
// Browser-side by REQUIREMENT, not preference: the key is HTTP-referrer ("Websites")
// restricted, so it is only accepted on requests that carry an allowed Referer --
// a server-side proxy would send none and be rejected. So this calls the Places API
// (New) REST endpoints directly from the browser with the public key.
//
// FAILURE IS VISIBLE, not silent. An earlier version degraded quietly to plain
// typing, which made a misconfigured key indistinguishable from "no suggestions" --
// undiagnosable from the outside. Now the real status/message is surfaced inline and
// the lookup is retryable, while typing still always works: a one-line address is
// enough on its own, because county is derived server-side from it (Census
// one-line geocoder) and RUCC follows from the county.
//
// Not-configured (no key) is a QUIET, expected state -- e.g. a *.vercel.app preview,
// where the referrer-locked key is intentionally not accepted. Only a real API
// failure is surfaced.

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
const MAX_FAILURES = 3; // stop hammering a broken config; retryable

type Suggestion = { placeId: string; primary: string; secondary: string };

type AddressComponent = { longText?: string; shortText?: string; types?: string[] };

// Pull the pieces we store out of the Places addressComponents list.
function parseComponents(components: AddressComponent[]) {
  const find = (type: string) => components.find((c) => (c.types ?? []).includes(type));
  const streetNumber = find("street_number")?.longText ?? "";
  const route = find("route")?.longText ?? "";
  // locality is the usual city; fall back to the sublocality/town variants some
  // addresses use instead.
  const city =
    find("locality")?.longText ??
    find("postal_town")?.longText ??
    find("sublocality_level_1")?.longText ??
    find("administrative_area_level_3")?.longText ??
    "";
  // County arrives as "Pulaski County"; store the bare name to match how the
  // roster (and the RUCC county lookup) holds it.
  const county = (find("administrative_area_level_2")?.longText ?? "").replace(/\s+County$/i, "");
  const state = find("administrative_area_level_1")?.shortText ?? "";
  const zip = find("postal_code")?.longText ?? "";
  return { street: [streetNumber, route].filter(Boolean).join(" "), city, county, state, zip };
}

// Compose the single visible line from stored parts (edit-mode prefill).
function composeLine(p: { street: string; city: string; state: string; zip: string }): string {
  const tail = [p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [p.street, tail].filter(Boolean).join(", ");
}

export function AddressAutocomplete({
  defaultStreet,
  defaultCity,
  defaultCounty,
  defaultState,
  defaultZip,
  defaultLine,
}: {
  defaultStreet?: string | null;
  defaultCity?: string | null;
  defaultCounty?: string | null;
  defaultState?: string | null;
  defaultZip?: string | null;
  // An ALREADY-COMPOSED full address line (the website-crafted address), used
  // verbatim for the visible field. Without this the line is composed from the
  // parts -- composing a full line WITH parts would duplicate the city/state/ZIP.
  defaultLine?: string | null;
}) {
  // Sanitize the configured key: a value pasted into the dashboard commonly carries
  // surrounding quotes or trailing whitespace, which Google rejects as
  // "400 API key not valid" -- indistinguishable from a genuinely wrong key. Strip
  // both so a cosmetic paste error can't masquerade as a bad key. (A stray newline
  // would make fetch throw on the header, so it is stripped here too.)
  const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();

  // Hidden, server-facing parts.
  const [street, setStreet] = useState(defaultStreet ?? "");
  const [city, setCity] = useState(defaultCity ?? "");
  const [county, setCounty] = useState(defaultCounty ?? "");
  const [stateVal, setStateVal] = useState(defaultState ?? "AR");
  const [zip, setZip] = useState(defaultZip ?? "");

  // The single visible line.
  const [line, setLine] = useState(
    (defaultLine ?? "").trim() ||
      composeLine({
        street: defaultStreet ?? "",
        city: defaultCity ?? "",
        state: defaultState ?? "",
        zip: defaultZip ?? "",
      }),
  );
  // Street resolved from a picked suggestion; cleared when the admin edits the line,
  // at which point the raw line is submitted as the address (the Census one-line
  // geocoder handles a full address string, so nothing downstream breaks).
  const [pickedStreet, setPickedStreet] = useState(defaultStreet ?? "");

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [apiError, setApiError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [showParts, setShowParts] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // One session token spans the keystrokes of a single lookup + its details call
  // (Google bills the session, not each keystroke); reset after a pick.
  const sessionRef = useRef<string>("");
  // A programmatic fill (choosing a suggestion) must not re-trigger the search.
  const skipNextRef = useRef(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Debounced suggestion fetch. Inert without a key, or after repeated failures.
  useEffect(() => {
    if (!apiKey || failures >= MAX_FAILURES) return;
    if (skipNextRef.current) {
      skipNextRef.current = false;
      return;
    }
    const q = line.trim();
    if (q.length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (!sessionRef.current) {
        sessionRef.current =
          typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
      }
      try {
        const res = await fetch(AUTOCOMPLETE_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask":
              "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
          },
          body: JSON.stringify({
            input: q,
            includedRegionCodes: ["us"], // GRANTED is domestic-only
            sessionToken: sessionRef.current,
          }),
        });
        if (!res.ok) {
          // Surface what Google actually said -- the difference between a blocked
          // referrer, a disabled API, and a bad key is the whole diagnosis.
          let detail = "";
          try {
            const body = (await res.json()) as { error?: { message?: string; status?: string } };
            detail = body.error?.message || body.error?.status || "";
          } catch {
            /* non-JSON error body */
          }
          throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
        }
        const data = (await res.json()) as {
          suggestions?: {
            placePrediction?: {
              placeId?: string;
              structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
            };
          }[];
        };
        const list: Suggestion[] = (data.suggestions ?? [])
          .map((s) => s.placePrediction)
          .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
          .map((p) => ({
            placeId: p.placeId as string,
            primary: p.structuredFormat?.mainText?.text ?? "",
            secondary: p.structuredFormat?.secondaryText?.text ?? "",
          }))
          .filter((s) => s.primary);
        setSuggestions(list);
        setActive(-1);
        setOpen(list.length > 0);
        setApiError(null);
        setFailures(0); // a success clears a transient failure streak
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        // Name the usual cause per failure class, so the message is actionable rather
        // than just Google's wording:
        //  - opaque "Failed to fetch" == CORS/network, normally a referrer restriction
        //  - 400 API_KEY_INVALID == the key STRING is wrong, or the build predates it
        //    (NEXT_PUBLIC_* is inlined at BUILD time, so saving the env var is not
        //    enough -- production must be redeployed)
        //  - 403 == the key is real but not permitted for this API/referrer
        const isNetwork = /failed to fetch|networkerror|load failed/i.test(msg);
        const isBadKey = /api key not valid|api_key_invalid/i.test(msg);
        const is403 = /HTTP 403/.test(msg);
        setApiError(
          isNetwork
            ? "Address lookup blocked (network/CORS). Usually the API key's Websites restriction does not allow this domain."
            : isBadKey
              ? `Address lookup failed: ${msg} — the key value looks wrong, or production hasn't been redeployed since it was added (the key is baked in at build time). Re-copy it into Vercel and redeploy.`
              : is403
                // The overwhelmingly common cause of a 403 is browsing a
                // *.vercel.app deployment/preview host instead of the custom domain:
                // the key's Websites restriction lists app.grantedco.com, so Google
                // rejects the raw deploy URL by design. Name that FIRST, because
                // "check your key restrictions" sends people to reconfigure a key
                // that is actually set up correctly.
                ? `Address lookup failed: ${msg} — ${
                    /vercel\.app$/.test(window.location.hostname)
                      ? `you're on ${window.location.hostname}, which the API key's Websites restriction doesn't cover. Open app.grantedco.com instead — the key is fine.`
                      : "the key is recognized but not permitted here: check its Websites restriction covers this domain and its API restrictions include Places API (New)."
                  }`
                : `Address lookup failed: ${msg}`,
        );
        setFailures((n) => n + 1);
        setSuggestions([]);
        setOpen(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [line, apiKey, failures]);

  async function choose(s: Suggestion) {
    setOpen(false);
    setSuggestions([]);
    skipNextRef.current = true;
    const full = [s.primary, s.secondary].filter(Boolean).join(", ");
    setLine(full);
    setStreet(s.primary);
    setPickedStreet(s.primary);
    if (!apiKey) return;
    try {
      const res = await fetch(
        `${DETAILS_URL}/${encodeURIComponent(s.placeId)}?sessionToken=${encodeURIComponent(sessionRef.current)}`,
        { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "addressComponents" } },
      );
      if (!res.ok) throw new Error(`details HTTP ${res.status}`);
      const data = (await res.json()) as { addressComponents?: AddressComponent[] };
      const parsed = parseComponents(data.addressComponents ?? []);
      // Only overwrite with something real -- never blank a field the pick didn't
      // resolve (e.g. a business with no street number keeps what was typed).
      if (parsed.street) {
        setStreet(parsed.street);
        setPickedStreet(parsed.street);
      }
      if (parsed.city) setCity(parsed.city);
      if (parsed.county) setCounty(parsed.county);
      if (parsed.state) setStateVal(parsed.state);
      if (parsed.zip) setZip(parsed.zip);
      setApiError(null);
    } catch (err) {
      // Keep the chosen text; the parts can be completed by hand (or derived
      // server-side from the one-line address).
      setApiError(`Couldn't load that address's details: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sessionRef.current = ""; // session ends with the details call
    }
  }

  function onLineChange(v: string) {
    setLine(v);
    setPickedStreet(""); // hand-edited -> submit the raw line as the address
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      // Only intercept Enter while a suggestion is highlighted, so Enter otherwise
      // still submits the form as usual.
      if (active >= 0) {
        e.preventDefault();
        void choose(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // What actually goes to the server as the address: the picked street when a
  // suggestion resolved one, else the raw typed line (geocoded server-side).
  const streetOut = pickedStreet || line.trim() || street;

  return (
    <div className="space-y-2">
      <div ref={wrapRef} className="relative space-y-2">
        <Label htmlFor="address_line">Address</Label>
        <Input
          id="address_line"
          value={line}
          onChange={(e) => onLineChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          placeholder="Start typing an address…"
        />
        {open && suggestions.length > 0 && (
          <ul className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-input bg-white shadow-lift">
            {suggestions.map((s, i) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(s)}
                  className={`block w-full px-3 py-2 text-left text-sm transition ${
                    i === active ? "bg-brand-navy/[0.06]" : "hover:bg-brand-navy/[0.04]"
                  }`}
                >
                  <span className="font-medium text-brand-navy">{s.primary}</span>
                  {s.secondary && <span className="block text-xs text-muted-foreground">{s.secondary}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Server-facing values. The admin sees one line; these carry the parts. */}
      <input type="hidden" name="location_street" value={streetOut} readOnly />
      {!showParts && (
        <>
          <input type="hidden" name="location_city" value={city} readOnly />
          <input type="hidden" name="location_county" value={county} readOnly />
          <input type="hidden" name="location_state" value={stateVal} readOnly />
          <input type="hidden" name="location_zip" value={zip} readOnly />
        </>
      )}

      {/* The real failure reason, when there is one. Actionable, not silent. */}
      {apiError && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
          {apiError}
          {failures >= MAX_FAILURES && " Suggestions are paused — type the address and it still saves."}{" "}
          <button
            type="button"
            onClick={() => {
              setFailures(0);
              setApiError(null);
            }}
            className="font-medium underline"
          >
            Retry
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {city || stateVal || zip
            ? `Resolved: ${[city, stateVal, zip].filter(Boolean).join(", ")}${county ? ` · ${county} County` : ""}`
            : "City, county, state, and ZIP fill in from the suggestion (or are derived on save)."}
        </span>
        <button
          type="button"
          onClick={() => setShowParts((v) => !v)}
          className="font-medium text-brand-orange hover:underline"
        >
          {showParts ? "Hide address parts" : "Edit parts manually"}
        </button>
      </div>

      {/* Manual escape hatch: real inputs (same names) replace the hidden ones. */}
      {showParts && (
        <div className="grid gap-4 pt-1 sm:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="location_city">City</Label>
            <Input id="location_city" name="location_city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="location_county">County</Label>
            <Input id="location_county" name="location_county" value={county} onChange={(e) => setCounty(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="location_state">State</Label>
            <Input id="location_state" name="location_state" value={stateVal} onChange={(e) => setStateVal(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="location_zip">ZIP</Label>
            <Input id="location_zip" name="location_zip" value={zip} onChange={(e) => setZip(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}
