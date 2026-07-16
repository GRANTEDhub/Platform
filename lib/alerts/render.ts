import fs from "node:fs/promises";
import path from "node:path";
import Handlebars from "handlebars";
import puppeteer, { type Browser } from "puppeteer-core";
import type { AlertData } from "./types";

// Render the grant-alert HTML template to a branded letter-size PDF via headless
// Chromium. Design owns the HTML (lib/alerts/template/grant-alert.hbs) -- we
// render it faithfully rather than re-authoring it. Chromium is isolated to this
// module (and the routes that import it); the contract PDF stays on @react-pdf.
//
// Serverless (Vercel): @sparticuz/chromium provides a Lambda-compatible binary.
// Locally / in the agent sandbox: point at a local Chrome via
// PUPPETEER_EXECUTABLE_PATH (falls back to the preinstalled Playwright chromium).

const ROOT = process.cwd();
let cachedTemplate: HandlebarsTemplateDelegate<AlertData> | null = null;
let cachedAssets: { navy: string; white: string } | null = null;
let cachedFontCss: string | null = null;

// Embed the brand fonts as local @font-face data URIs. Fetching Google Fonts at
// render time is unreliable in serverless (cold DNS / blocked egress), and when
// the CDN is slow Chromium prints before the faces load -> the garbled
// letter-spacing we saw. Local TTFs (the same files the contract PDF uses)
// guarantee correct glyphs and kerning every render. Only Regular (400) and
// SemiBold (600) weights are vendored, so each face covers a weight RANGE: the
// template's 400/500 map to Regular and 600/700 to SemiBold.
async function loadFontCss(): Promise<string> {
  if (!cachedFontCss) {
    const dir = path.join(ROOT, "lib/contracts/fonts");
    const [serifReg, serifSemi, interReg, interSemi] = await Promise.all([
      fs.readFile(path.join(dir, "SourceSerif4-Regular.ttf")),
      fs.readFile(path.join(dir, "SourceSerif4-SemiBold.ttf")),
      fs.readFile(path.join(dir, "InterTight-Regular.ttf")),
      fs.readFile(path.join(dir, "InterTight-SemiBold.ttf")),
    ]);
    const face = (family: string, buf: Buffer, weight: string) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;` +
      `src:url(data:font/ttf;base64,${buf.toString("base64")}) format('truetype');}`;
    cachedFontCss = [
      face("Source Serif 4", serifReg, "400 500"),
      face("Source Serif 4", serifSemi, "600 700"),
      face("Inter Tight", interReg, "400 500"),
      face("Inter Tight", interSemi, "600 700"),
    ].join("");
  }
  return cachedFontCss;
}

async function loadTemplate() {
  if (!cachedTemplate) {
    const raw = await fs.readFile(path.join(ROOT, "lib/alerts/template/grant-alert.hbs"), "utf8");
    cachedTemplate = Handlebars.compile<AlertData>(raw);
  }
  return cachedTemplate;
}

// The two logo marks are inlined as data URIs -- relative asset paths can't
// resolve when Chromium renders from an in-memory string.
async function loadAssets() {
  if (!cachedAssets) {
    const dir = path.join(ROOT, "lib/alerts/assets");
    const [navy, white] = await Promise.all([
      fs.readFile(path.join(dir, "granted-mark-navy.png")),
      fs.readFile(path.join(dir, "granted-mark-white.png")),
    ]);
    cachedAssets = {
      navy: `data:image/png;base64,${navy.toString("base64")}`,
      white: `data:image/png;base64,${white.toString("base64")}`,
    };
  }
  return cachedAssets;
}

export async function renderAlertHtml(data: AlertData): Promise<string> {
  const [tpl, assets, fontCss] = await Promise.all([loadTemplate(), loadAssets(), loadFontCss()]);
  return tpl(data)
    .replace("assets/granted-mark-navy.png", assets.navy)
    .replace("assets/granted-mark-white.png", assets.white)
    // Inject the embedded @font-face rules right before </head> so they win over
    // the CDN <link> (which stays as a harmless progressive-enhancement fallback).
    .replace("</head>", `<style>${fontCss}</style></head>`);
}

async function launch(): Promise<Browser> {
  const serverless = !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.VERCEL;
  if (serverless) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

export async function renderAlertPdf(data: AlertData): Promise<Buffer> {
  const html = await renderAlertHtml(data);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    // Wait for the template's Google Fonts to actually load before printing; if
    // the CDN is unreachable the template's Georgia/Arial fallbacks apply.
    try {
      await page.evaluate(() => (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready);
    } catch {
      /* fonts.ready unsupported -> proceed with whatever loaded */
    }
    // pageRanges:"1" is a hard backstop -- the template is sized to exactly one
    // letter page (fixed 1056px height, overflow hidden), but this guarantees we
    // never emit a stray second page even if content is unexpectedly tall.
    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      preferCSSPageSize: true,
      pageRanges: "1",
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Forecasted "On the horizon" page (single-send v1) ────────────────────────
// A standalone, brand-styled ONE-page PDF listing the forecasted opportunities on
// the horizon for the recipient org, concatenated onto the alert at single-send
// assembly (store.ts). Deliberately its OWN document: the page-1 alert stays byte-
// locked (renderAlertPdf, pageRanges "1"), and this never enters the shared per-card
// PDF, so the batch merge is untouched. Authored from scratch -- no deadlineLong, no
// "was published": forecasted grants have neither, and we assert no firm date.
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type HorizonRenderItem = { title: string; funder: string | null; rationale: string };

function horizonHtml(items: HorizonRenderItem[], fontCss: string, logo: string): string {
  const rows = items
    .map(
      (it) => `<li class="item">
      <div class="title">${escHtml(it.title || "Forecasted opportunity")}</div>
      ${it.funder ? `<div class="funder">${escHtml(it.funder)}</div>` : ""}
      <div class="rationale">${escHtml(it.rationale)}</div>
    </li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontCss}
    @page { size: letter; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 8.5in; min-height: 11in; }
    body { font-family: 'Inter Tight', Arial, sans-serif; color: #0B1E3A; background: #faf7f2; }
    .header { background: #0B1E3A; color: #fff; padding: 40px 56px 30px; }
    .header img { height: 24px; margin-bottom: 18px; display: block; }
    .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #E4761F; font-weight: 600; }
    h1 { font-family: 'Source Serif 4', Georgia, serif; font-size: 29px; font-weight: 600; margin-top: 6px; }
    .sub { font-size: 12.5px; color: #cdd6e2; margin-top: 11px; max-width: 6in; line-height: 1.55; }
    .body { padding: 28px 56px 20px; }
    .lede { font-size: 12.5px; color: #3a4a63; line-height: 1.55; margin-bottom: 18px; }
    ul { list-style: none; }
    .item { padding: 12px 0; border-top: 1px solid #e6ded2; }
    .item:first-child { border-top: none; }
    .title { font-family: 'Source Serif 4', Georgia, serif; font-size: 14px; font-weight: 600; color: #0B1E3A; line-height: 1.3; }
    .funder { font-size: 10.5px; color: #8a7a66; margin-top: 3px; }
    .rationale { font-size: 11.5px; color: #3a4a63; line-height: 1.5; margin-top: 5px; }
    .foot { padding: 8px 56px 32px; font-size: 10px; color: #8a7a66; line-height: 1.45; }
  </style></head><body>
    <div class="header">
      <img src="${logo}" alt="GRANTED" />
      <div class="eyebrow">On the horizon</div>
      <h1>Anticipated postings</h1>
      <div class="sub">These federal opportunities have not opened for applications yet. We are flagging them so your organization can prepare early. Dates and details firm up when each one posts.</div>
    </div>
    <div class="body">
      <div class="lede">Worth watching for your organization, most relevant first:</div>
      <ul>${rows}</ul>
    </div>
    <div class="foot">Forecasted opportunities are estimates and not yet open for application. GRANTED verifies eligibility and timing against the official notice once each one posts.</div>
  </body></html>`;
}

export async function renderHorizonPdf(items: HorizonRenderItem[]): Promise<Buffer> {
  const [assets, fontCss] = await Promise.all([loadAssets(), loadFontCss()]);
  const html = horizonHtml(items, fontCss, assets.white);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    try {
      await page.evaluate(() => (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready);
    } catch {
      /* proceed with whatever loaded */
    }
    // One page: the cap of 8 items fits comfortably. pageRanges "1" backstops overflow.
    const pdf = await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true, pageRanges: "1" });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
