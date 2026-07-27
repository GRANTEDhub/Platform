import Link from "next/link";
import { Radar, UserPlus, ArrowRight, type LucideIcon } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { NavyHero } from "@/components/ui/navy-hero";

export const dynamic = "force-dynamic";

// Prospecting landing (Track 2, admin-only). Two doors:
//   1. Grant prospecting — the grant-centric feed we've built (discover fitting
//      non-client orgs per grant). -> /intel/grants
//   2. Add prospect — stand up a prospective CLIENT (a lead: staff-only, no portal,
//      no daily matching) and map grants for them. Reuses the Add Client/Prospect
//      form in prospect mode. -> /clients/new?kind=prospect
export default async function ProspectingLandingPage() {
  await requireAdmin();

  return (
    <div className="space-y-6 p-6">
      <NavyHero
        eyebrow="Prospecting"
        title="Prospecting"
        subtitle="Two ways to prospect: work a grant to find fitting non-client orgs, or add a prospective client and map grants for them."
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <ProspectingCard
          href="/intel/grants"
          icon={Radar}
          title="Grant prospecting"
          body="Browse every scored grant and its client-match status, then discover fitting non-client orgs to reach out to."
        />
        <ProspectingCard
          href="/intel/prospects/new"
          icon={UserPlus}
          title="Add prospect"
          body="Add a prospective client — staff-only, no portal, no daily matching. Generate their grant report on demand, then review and send one-pagers."
        />
      </div>
    </div>
  );
}

function ProspectingCard({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <Link href={href} className="group block">
      <div className="flex h-full flex-col rounded-2xl border border-brand-navy/[0.06] bg-white p-6 shadow-soft transition hover:shadow-lift">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-navy text-white">
          <Icon className="h-5 w-5" />
        </span>
        <h3 className="mt-4 text-[17px] font-semibold text-brand-navy">{title}</h3>
        <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-orange">
          Open
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
