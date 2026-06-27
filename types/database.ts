// Hand-maintained types mirroring supabase/migrations/0001_init.sql.
// Regenerate with `supabase gen types typescript` once the CLI is wired up.

export type UserRole = "admin" | "contractor";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  name: string;
  org_type: string | null;
  status: string;
  engagement_tier: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  location_city: string | null;
  location_county: string | null;
  location_state: string | null;
  service_area: string[] | null;
  retainer_hours: number | null;
  contract_start: string | null;
  contract_end: string | null;
  next_step: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientOverview {
  id: string;
  name: string;
  org_type: string | null;
  status: string;
  engagement_tier: string | null;
  contract_end: string | null;
  next_step: string | null;
  retainer_hours: number | null;
  hours_logged: number;
  hours_remaining: number;
  owed_cents: number;
  next_deadline: string | null;
}

export interface TimeEntry {
  id: string;
  client_id: string;
  user_id: string | null;
  work_date: string;
  hours: number;
  description: string | null;
  billable: boolean;
  created_at: string;
}

export interface Invoice {
  id: string;
  client_id: string;
  amount_cents: number;
  status: string;
  issued_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  stripe_invoice_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Minimal placeholder so the generic Supabase client type-checks. The grant
// tables are fleshed out in the grant-intelligence phase.
export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile>; Relationships: [] };
      clients: { Row: Client; Insert: Partial<Client>; Update: Partial<Client>; Relationships: [] };
      time_entries: { Row: TimeEntry; Insert: Partial<TimeEntry>; Update: Partial<TimeEntry>; Relationships: [] };
      invoices: { Row: Invoice; Insert: Partial<Invoice>; Update: Partial<Invoice>; Relationships: [] };
    };
    Views: {
      client_overview: { Row: ClientOverview; Relationships: [] };
    };
    Functions: Record<string, never>;
    Enums: { user_role: UserRole };
    CompositeTypes: Record<string, never>;
  };
}
