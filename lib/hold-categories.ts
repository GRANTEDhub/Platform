// Structured hold reasons. Plain text validated in app code (not a Postgres
// enum), so the option list can change without a migration. Shared by the PATCH
// route (validation), the decision bar (selector), and the review page (label).
// A null category is a legacy/uncategorized hold (pre-0017, or mid-transition).

export const HOLD_CATEGORIES = [
  { value: "wrong_timing", label: "Wrong timing" },
  { value: "pending_partner", label: "Pending partner response" },
  { value: "need_more_info", label: "Need more info" },
  { value: "internal_review", label: "Internal review required" },
  { value: "other", label: "Other" },
] as const;

export type HoldCategory = (typeof HOLD_CATEGORIES)[number]["value"];

export const HOLD_CATEGORY_VALUES: HoldCategory[] = HOLD_CATEGORIES.map((c) => c.value);

// Free text is REQUIRED only for this category; optional everywhere else.
export const HOLD_CATEGORY_REQUIRING_NOTE: HoldCategory = "other";

export function holdCategoryLabel(value: string | null | undefined): string {
  return HOLD_CATEGORIES.find((c) => c.value === value)?.label ?? "Uncategorized";
}
