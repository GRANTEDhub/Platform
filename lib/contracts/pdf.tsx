import path from "path";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  renderToBuffer,
} from "@react-pdf/renderer";
import { CONTRACT_TEMPLATES, formatAmount, type TemplateKey } from "@/lib/contracts/template";
import { BRAND } from "@/lib/brand";

// Branded signed-contract PDF, GRANTED design system. react-pdf (pure JS) is used
// because generation runs in a Vercel serverless function where headless Chromium
// isn't available; our contract content is our own structured text, so we render a
// branded document rather than converting arbitrary HTML. Fonts are embedded from
// vendored static TTFs (Source Serif 4 + Inter Tight) so brand hierarchy holds --
// see next.config outputFileTracingIncludes for serverless bundling of the .ttf.

// Palette sourced from lib/brand.ts so the PDF rebrands with everything else.
const NAVY = BRAND.navy;
const ORANGE = BRAND.orange;
const CREAM = BRAND.cream;
const INK = BRAND.ink;
const MUTED = BRAND.muted;

const FONT_DIR = path.join(process.cwd(), "lib/contracts/fonts");
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  Font.register({
    family: "Source Serif 4",
    fonts: [
      { src: path.join(FONT_DIR, "SourceSerif4-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "SourceSerif4-SemiBold.ttf"), fontWeight: 600 },
    ],
  });
  Font.register({
    family: "Inter Tight",
    fonts: [
      { src: path.join(FONT_DIR, "InterTight-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "InterTight-SemiBold.ttf"), fontWeight: 600 },
    ],
  });
  fontsRegistered = true;
}

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 64, paddingHorizontal: 56, fontFamily: "Inter Tight", fontSize: 10, lineHeight: 1.5, color: INK },
  bar: { height: 4, backgroundColor: ORANGE, marginBottom: 18, borderRadius: 2 },
  brand: { fontFamily: "Source Serif 4", fontWeight: 600, fontSize: 15, color: NAVY, letterSpacing: 0.5 },
  brandAddr: { fontSize: 8, color: MUTED, marginTop: 2, lineHeight: 1.4 },
  title: { fontFamily: "Source Serif 4", fontWeight: 600, fontSize: 20, color: NAVY, marginTop: 22 },
  dateLine: { fontSize: 9, color: MUTED, marginTop: 4, marginBottom: 14 },
  intro: { marginBottom: 14 },
  sectionHead: { fontFamily: "Inter Tight", fontWeight: 600, fontSize: 9, color: ORANGE, letterSpacing: 1, textTransform: "uppercase", marginTop: 16, marginBottom: 6 },
  infoCard: { backgroundColor: CREAM, borderRadius: 6, padding: 10, borderLeft: `3 solid ${NAVY}` },
  infoRow: { flexDirection: "row", marginBottom: 3 },
  infoLabel: { width: 90, color: MUTED, fontSize: 9 },
  infoVal: { flex: 1, fontSize: 9, color: INK },
  scopeItem: { flexDirection: "row", marginBottom: 5 },
  bullet: { width: 10, color: ORANGE },
  term: { marginBottom: 7 },
  termNum: { fontWeight: 600, color: NAVY },
  sigWrap: { marginTop: 22, borderTop: `1 solid #e3ded5`, paddingTop: 14 },
  sigName: { fontFamily: "Source Serif 4", fontWeight: 600, fontSize: 16, color: NAVY },
  sigMeta: { fontSize: 9, color: MUTED, marginTop: 3 },
  provider: { marginTop: 12, fontSize: 9, color: INK },
  audit: { marginTop: 18, backgroundColor: "#f3f1ec", borderRadius: 6, padding: 10 },
  auditHead: { fontFamily: "Inter Tight", fontWeight: 600, fontSize: 8, color: MUTED, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
  auditLine: { fontSize: 8, color: MUTED, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 28, left: 56, right: 56, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: MUTED },
});

export interface SignedContractData {
  orgName: string;
  repName: string | null;
  email: string | null;
  templateKey: string;
  amountCents: number | null;
  dateLabel: string;
  signerName: string;
  signedAtLabel: string;
  signerIp: string | null;
  signerUserAgent: string | null;
}

function meta(k: string) {
  return (CONTRACT_TEMPLATES as Record<string, (typeof CONTRACT_TEMPLATES)[TemplateKey]>)[k] ?? CONTRACT_TEMPLATES.custom;
}

const COMMON_TERMS = [
  ["Client Obligations", "Client agrees to provide necessary access, cooperation, and timely input. Delays caused by the Client may affect timelines."],
  ["Term; Termination", "The engagement commences on full execution. Either party may terminate for material breach or at will with ten (10) business days' written notice. Provider is entitled to payment for services rendered up to termination."],
  ["Confidentiality", "Both parties maintain confidentiality of proprietary or sensitive information exchanged; obligations survive termination."],
  ["Disclaimer of Warranty", 'Provider makes no guarantee of funding success. All services are provided "as-is."'],
  ["Ownership", "Each party retains its pre-existing materials and IP. Jointly developed work product is jointly owned; neither party may sell or license it to third parties without the other's written consent."],
  ["Indemnification", "Each party indemnifies the other against claims arising from its own gross negligence, misconduct, or breach."],
  ["Limitation of Liability", "Provider's liability is limited to the amount paid under this Agreement. Neither party is liable for indirect or consequential damages."],
  ["Force Majeure", "Neither party is liable for delays or failures caused by events beyond reasonable control."],
  ["Governing Law", "Governed by the laws of the State of Arkansas. Venue lies in Benton County, AR."],
  ["Entire Agreement", "This document is the entire understanding between the parties. Modifications must be in writing and signed."],
  ["Survival", "Confidentiality, Ownership, Indemnification, Limitation of Liability, and Governing Law survive termination."],
];

function ContractDoc({ d }: { d: SignedContractData }) {
  const t = meta(d.templateKey);
  const fee = formatAmount(d.amountCents ?? t.defaultAmountCents);
  return (
    <Document title={`${t.name} Agreement — ${d.orgName}`} author="GRANTED, LLC">
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.bar} />
        <Text style={styles.brand}>GRANTED</Text>
        <Text style={styles.brandAddr}>GRANTED, LLC · 240 S Main St, # 276 · Bentonville, AR 72712 · support@grantedco.com</Text>

        <Text style={styles.title}>{t.name} Agreement</Text>
        <Text style={styles.dateLine}>Dated {d.dateLabel}</Text>

        <Text style={styles.intro}>
          This Consulting Services Agreement (&quot;Agreement&quot;) is entered into between GRANTED, LLC, an Arkansas
          Limited Liability Company (&quot;Provider&quot;), and the Client identified below (&quot;Client&quot;). It governs the
          terms of engagement for grant-related consulting services.
        </Text>

        <Text style={styles.sectionHead}>Client</Text>
        <View style={styles.infoCard}>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Organization</Text><Text style={styles.infoVal}>{d.orgName}</Text></View>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Representative</Text><Text style={styles.infoVal}>{d.repName || "—"}</Text></View>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Email</Text><Text style={styles.infoVal}>{d.email || "—"}</Text></View>
        </View>

        <Text style={styles.sectionHead}>Scope of Services (Exhibit A)</Text>
        <View style={styles.infoCard}>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Package</Text><Text style={styles.infoVal}>{t.name}</Text></View>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Fee</Text><Text style={styles.infoVal}>{fee}</Text></View>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Term</Text><Text style={styles.infoVal}>{t.term}</Text></View>
        </View>
        <View style={{ marginTop: 8 }}>
          {t.scope.map((s, i) => (
            <View key={i} style={styles.scopeItem}>
              <Text style={styles.bullet}>•</Text>
              <Text style={{ flex: 1 }}>{s}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionHead}>Key Terms and Conditions</Text>
        {COMMON_TERMS.map(([h, body], i) => (
          <Text key={i} style={styles.term}>
            <Text style={styles.termNum}>{i + 1}. {h}. </Text>
            {body}
          </Text>
        ))}

        <View style={styles.sigWrap} wrap={false}>
          <Text style={styles.sectionHead}>Electronic Signature</Text>
          <Text style={styles.sigName}>{d.signerName}</Text>
          <Text style={styles.sigMeta}>Signed electronically on {d.signedAtLabel}</Text>
          <Text style={styles.provider}>
            GRANTED, LLC — Shannon Anastosopolos, Founder &amp; CEO
          </Text>
          <View style={styles.audit}>
            <Text style={styles.auditHead}>Electronic Signature Audit Trail</Text>
            <Text style={styles.auditLine}>Signer: {d.signerName}{d.email ? ` (${d.email})` : ""}</Text>
            <Text style={styles.auditLine}>Signed at: {d.signedAtLabel}</Text>
            <Text style={styles.auditLine}>IP address: {d.signerIp || "—"}</Text>
            <Text style={styles.auditLine}>Device: {(d.signerUserAgent || "—").slice(0, 180)}</Text>
            <Text style={styles.auditLine}>
              The signer typed their full name and affirmed consent to be legally bound; this document was
              signed electronically via GRANTED&apos;s signing system.
            </Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>GRANTED, LLC · {t.name} Agreement</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

// Renders the signed contract to a PDF Buffer. Called from the background
// generate-and-deliver step after a signature is recorded.
export async function renderSignedContractPdf(d: SignedContractData): Promise<Buffer> {
  ensureFonts();
  return renderToBuffer(<ContractDoc d={d} />);
}
