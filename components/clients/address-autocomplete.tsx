"use client";

import { useEffect, useRef, useState } from "react";
import { Input, Label } from "@/components/ui/input";

// Google-Maps-style address autocomplete for the client/prospect form: type into
// Street address, pick a suggestion, and city / county / state / ZIP fill in.
//
// Browser-side by REQUIREMENT, not preference: the key is HTTP-referrer ("Websites")
// restricted, so it is only accepted on requests that carry an allowed Referer —
// a server-side proxy would send none and be rejected. So this calls the Places API
// (New) REST endpoints directly from the browser with the public key.
//
// GRACEFUL DEGRADATION is the whole design: with no key configured, a referrer the
// key doesn't allow (e.g. a *.vercel.app preview), or any API/network failure, it
// silently falls back to plain typed inputs — exactly the pre-autocomplete behavior.
// Autocomplete is a typing convenience; county is independently derived server-side
// (Census geocoder), so nothing downstream depends on this working.
//
// Field `name`s are unchanged (location_street/city/county/state/zip) so the server
// action needs no changes.

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

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
  return {
    street: [streetNumber, route].filter(Boolean).join(" "),
    city,
    county,
    state,
    zip,
  };
}

export function AddressAutocomplete({
  defaultStreet,
  defaultCity,
  defaultCounty,
  defaultState,
  defaultZip,
}: {
  defaultStreet?: string | null;
  defaultCity?: string | null;
  defaultCounty?: string | null;
  defaultState?: string | null;
  defaultZip?: string | null;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  const [street, setStreet] = useState(defaultStreet ?? "");
  const [city, setCity] = useState(defaultCity ?? "");
  const [county, setCounty] = useState(defaultCounty ?? "");
  const [stateVal, setStateVal] = useState(defaultState ?? "AR");
  const [zip, setZip] = useState(defaultZip ?? "");

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [degraded, setDegraded] = useState(false); // an API failure -> stop trying, plain typing
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

  // Debounced suggestion fetch. Inert without a key or after a failure.
  useEffect(() => {
    if (!apiKey || degraded) return;
    if (skipNextRef.current) {
      skipNextRef.current = false;
      return;
    }
    const q = street.trim();
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
        if (!res.ok) throw new Error(`autocomplete ${res.status}`);
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
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // Key rejected for this referrer / API disabled / offline / CORS: stop
        // trying and let the admin type the address normally.
        setDegraded(true);
        setSuggestions([]);
        setOpen(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [street, apiKey, degraded]);

  async function choose(s: Suggestion) {
    setOpen(false);
    setSuggestions([]);
    skipNextRef.current = true;
    setStreet(s.primary); // immediate feedback; refined by the details call below
    if (!apiKey) return;
    try {
      const res = await fetch(
        `${DETAILS_URL}/${encodeURIComponent(s.placeId)}?sessionToken=${encodeURIComponent(sessionRef.current)}`,
        {
          headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "addressComponents",
          },
        },
      );
      if (!res.ok) throw new Error(`details ${res.status}`);
      const data = (await res.json()) as { addressComponents?: AddressComponent[] };
      const parsed = parseComponents(data.addressComponents ?? []);
      // Only overwrite with something real -- never blank a field the pick didn't
      // resolve (e.g. a business with no street number keeps what was typed).
      skipNextRef.current = true;
      if (parsed.street) setStreet(parsed.street);
      if (parsed.city) setCity(parsed.city);
      if (parsed.county) setCounty(parsed.county);
      if (parsed.state) setStateVal(parsed.state);
      if (parsed.zip) setZip(parsed.zip);
    } catch {
      // Keep the chosen text; the admin can complete the rest by hand.
    } finally {
      sessionRef.current = ""; // session ends with the details call
    }
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

  return (
    <div className="space-y-4">
      <div ref={wrapRef} className="relative space-y-2">
        <Label htmlFor="location_street">Street address</Label>
        <Input
          id="location_street"
          name="location_street"
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          placeholder={
            apiKey && !degraded
              ? "Start typing an address — suggestions fill city, county, state, ZIP"
              : "e.g. 500 W Markham St (enables tract-level need + eligibility data)"
          }
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

      <div className="grid gap-4 sm:grid-cols-4">
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
    </div>
  );
}
