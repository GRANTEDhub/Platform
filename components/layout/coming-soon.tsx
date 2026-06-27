import { PageHeader } from "@/components/layout/page-header";

export function ComingSoon({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <div className="p-8">
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card py-20 text-center">
          <p className="text-sm font-medium">Coming in {phase}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            The foundation (auth, roles, and the client dashboard) is in place.
            This section is next on the build order.
          </p>
        </div>
      </div>
    </div>
  );
}
