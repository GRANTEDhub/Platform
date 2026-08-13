"use client";

import { useState, type ComponentProps } from "react";
import { GrantBotChat } from "@/components/grantbot/grantbot-chat";
import { ArtifactPanel } from "@/components/grantbot/artifact-panel";

// The full-page GrantBot workspace: the conversation, and -- when GRANTBOT_ARTIFACTS_ENABLED is on --
// the document artifact pane beside it. The parent (a server component) reads the flag and passes it
// down, so this stays a thin client shell whose only job is to bump the pane's reloadKey when a turn
// completes (a turn can write/edit a document).
//
// FLAG OFF IS TODAY'S PAGE. With artifactsEnabled=false this renders exactly <GrantBotChat> and
// nothing else -- no wrapper, no layout change -- so the full page is byte-identical to pre-1a.

type ChatProps = ComponentProps<typeof GrantBotChat>;

export function GrantBotWorkspace({ artifactsEnabled, ...chatProps }: ChatProps & { artifactsEnabled: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);

  if (!artifactsEnabled) return <GrantBotChat {...chatProps} />;

  return (
    <div className="flex min-h-0 w-full flex-1 gap-6">
      <div className="flex min-h-0 min-w-0 flex-1 basis-1/2">
        <GrantBotChat {...chatProps} onTurnComplete={() => setReloadKey((k) => k + 1)} />
      </div>
      <div className="flex min-h-0 flex-1 basis-1/2 flex-col overflow-hidden rounded-lg border border-hairline-strong bg-white">
        <div className="shrink-0 border-b border-hairline-strong px-4 py-2 text-[12.5px] font-semibold text-brand-navy">
          Documents
        </div>
        <div className="min-h-0 flex-1">
          <ArtifactPanel clientId={chatProps.clientId} reloadKey={reloadKey} />
        </div>
      </div>
    </div>
  );
}
