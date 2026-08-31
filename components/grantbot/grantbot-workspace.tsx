"use client";

import { useState, type ComponentProps } from "react";
import { FileText, PanelRightClose } from "lucide-react";
import { GrantBotChat } from "@/components/grantbot/grantbot-chat";
import { ArtifactPanel } from "@/components/grantbot/artifact-panel";

// The full-page GrantBot workspace: the conversation, and -- when GRANTBOT_ARTIFACTS_ENABLED is on --
// the document artifact pane beside it. The parent (a server component) reads the flag and passes it
// down, so this stays a thin client shell whose only job is to bump the pane's reloadKey when a turn
// completes (a turn can write/edit a document).
//
// THE DOCUMENTS PANE DEFAULTS CLOSED. The chat is what staff open the page for; the pane is a
// side surface reached when they want to see or export a drafted document. So it starts collapsed
// to a slim tab on the right, giving the transcript the full width, and opens on a click. reloadKey
// still bumps while it is closed (harmless: the panel is unmounted, so the bumps are ignored), and
// it fetches fresh on the mount that reopening triggers -- so reopening never shows a stale list.
//
// FLAG OFF IS TODAY'S PAGE. With artifactsEnabled=false this renders exactly <GrantBotChat> and
// nothing else -- no wrapper, no layout change, no tab -- so the full page is byte-identical to pre-1a.

type ChatProps = ComponentProps<typeof GrantBotChat>;

export function GrantBotWorkspace({ artifactsEnabled, ...chatProps }: ChatProps & { artifactsEnabled: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [docsOpen, setDocsOpen] = useState(false);

  if (!artifactsEnabled) return <GrantBotChat {...chatProps} />;

  return (
    <div className="flex min-h-0 w-full flex-1 gap-6">
      <div className="flex min-h-0 min-w-0 flex-1">
        <GrantBotChat {...chatProps} onTurnComplete={() => setReloadKey((k) => k + 1)} />
      </div>

      {docsOpen ? (
        <div className="flex min-h-0 flex-1 basis-1/2 flex-col overflow-hidden rounded-lg border border-hairline-strong bg-white">
          <div className="flex shrink-0 items-center justify-between border-b border-hairline-strong px-4 py-2">
            <span className="text-[12.5px] font-semibold text-brand-navy">Documents</span>
            <button
              type="button"
              onClick={() => setDocsOpen(false)}
              aria-label="Close Documents"
              title="Close Documents"
              className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-brand-navy/5 hover:text-brand-navy"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ArtifactPanel clientId={chatProps.clientId} reloadKey={reloadKey} />
          </div>
        </div>
      ) : (
        // Collapsed: a slim right-edge tab that opens the pane. Vertical label, so the closed state
        // costs almost no width while staying discoverable.
        <button
          type="button"
          onClick={() => setDocsOpen(true)}
          aria-expanded={false}
          title="Open Documents"
          className="flex shrink-0 flex-col items-center gap-2 rounded-lg border border-hairline-strong bg-white px-2 py-3 text-brand-navy transition-colors hover:border-brand-navy/30"
        >
          <FileText className="h-4 w-4" />
          <span className="text-[11px] font-semibold [writing-mode:vertical-rl]">Documents</span>
        </button>
      )}
    </div>
  );
}
