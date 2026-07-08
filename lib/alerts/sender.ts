// Resolve the first name shown in a prospect alert's intro ("I'm {First} with
// GRANTED..."). Prospect-only; client alerts carry no sender name.
//
// STOPGAP (issue #81): profiles has no dedicated first-name field -- only
// `full_name` (nullable, seeded from signup metadata) and `email`. Until the
// user-access build adds a real profile first-name field, this hardcoded
// email->first-name map is the authoritative source for the known senders (it
// also captures preferred names, e.g. samantha@ -> "Sam", which a full_name
// first-token could not). REPLACE this map with the profile field when that build
// lands -- do not let it rot.
const SENDER_FIRST_NAMES: Record<string, string> = {
  "shannon@grantedco.com": "Shannon",
  "christine@grantedco.com": "Christine",
  "tara@grantedco.com": "Tara",
  "samantha@grantedco.com": "Sam",
};

// The sender's first name, or null when we can't resolve a real one. Order:
//   1. the email->first-name stopgap map (preferred names for known senders);
//   2. the first whitespace-delimited token of `full_name`, if set;
//   3. null -- caller uses the name-less intro. NEVER an email/username as a name.
export function senderFirstName(
  profile: { full_name?: string | null; email?: string | null } | null | undefined,
): string | null {
  const email = profile?.email?.trim().toLowerCase();
  if (email && SENDER_FIRST_NAMES[email]) return SENDER_FIRST_NAMES[email];

  const first = profile?.full_name?.trim().split(/\s+/)[0];
  return first || null;
}
