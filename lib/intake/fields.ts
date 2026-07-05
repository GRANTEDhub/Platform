// Shared option lists for the public intake form. Imported by both the client
// form and the server-side validator so the two never drift. No server-only
// imports here -- this module is safe in a client component.
//
// Design: "enrich, don't interrogate." We ask only what the org uniquely knows.
// Federal grant history is NOT asked -- USASpending enrichment fills it after
// submit. Budget / summary / partners / constraints are gathered on the
// discovery call, not the form.

// Organization type, federal-code list (parity with GOH's intake, kept because
// the code helps a later SAM entity lookup). Value stored on the lead is the
// label; the code rides along in intake_data for enrichment.
export const ORG_TYPES: { code: string; label: string }[] = [
  { code: "00", label: "State government" },
  { code: "01", label: "County government" },
  { code: "02", label: "City or township government" },
  { code: "04", label: "Special district government" },
  { code: "05", label: "Independent school district" },
  { code: "06", label: "Public / state-controlled higher education" },
  { code: "07", label: "Federally recognized tribal government" },
  { code: "08", label: "Public / Indian housing authority" },
  { code: "11", label: "Other tribal organization" },
  { code: "12", label: "Nonprofit with 501(c)(3) status" },
  { code: "13", label: "Nonprofit without 501(c)(3) status" },
  { code: "20", label: "Private higher education" },
  { code: "22", label: "For-profit (other than small business)" },
  { code: "23", label: "Small business" },
  { code: "25", label: "Other" },
];

export const ORG_TYPE_LABELS = ORG_TYPES.map((t) => t.label);

// Priority funding areas (checkboxes, optional) -- parity with GOH's list.
export const PRIORITY_AREAS: string[] = [
  "Program expansion / direct services",
  "Staffing / workforce",
  "Equipment / technology",
  "Capital / construction / renovation",
  "Vehicles / mobile service delivery",
  "Planning / assessment",
  "Evaluation / data systems",
  "Community outreach / engagement",
  "Other",
];

// "How did you hear about us?" (optional)
export const REFERRAL_SOURCES: string[] = [
  "Website",
  "Referral",
  "LinkedIn",
  "Google search",
  "Event / conference",
  "Other",
];

// US state / territory two-letter codes for the location select (domestic-only firm).
export const US_STATES: string[] = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC","PR","VI","GU","AS","MP",
];
