"use client";

import { useState } from "react";
import { UserPlus, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// Pipeline header actions. Only "Copy intake link" is wired (the public /intake
// form exists). "Create outbound lead" is stubbed (disabled) -- no create-lead
// action exists yet; leads are born via inbound intake or prospect promotion.
export function PipelineHeaderActions() {
  const [copied, setCopied] = useState(false);

  const copyIntakeLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/intake`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        title="Coming soon — no create-lead action yet"
      >
        <UserPlus className="mr-2 h-4 w-4" />
        Create outbound lead
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={copyIntakeLink}>
        <LinkIcon className="mr-2 h-4 w-4" />
        {copied ? "Copied" : "Copy intake link"}
      </Button>
    </div>
  );
}
