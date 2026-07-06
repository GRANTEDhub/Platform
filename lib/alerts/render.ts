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

// Diagnostic: prove (on the actual deploy) that the brand TTFs ship in the
// function AND that the @font-face data URIs are applied by Chromium at render.
// The sandbox always has the fonts locally, so it can't surface a serverless
// file-tracing gap -- this runs the same read + render path and reports what the
// live function actually sees. Hit /api/alerts/[cardId]/pdf?debug=fonts (admin).
export async function debugAlertFonts(data: AlertData): Promise<Record<string, unknown>> {
  const dir = path.join(ROOT, "lib/contracts/fonts");
  const files = [
    "SourceSerif4-Regular.ttf",
    "SourceSerif4-SemiBold.ttf",
    "InterTight-Regular.ttf",
    "InterTight-SemiBold.ttf",
  ];
  const fileChecks = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await fs.stat(path.join(dir, f));
        return { file: f, exists: true, bytes: st.size };
      } catch (e) {
        return { file: f, exists: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const html = await renderAlertHtml(data);
  const htmlHasEmbeddedFont = html.includes("data:font/ttf;base64,");
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    try {
      await page.evaluate(() => (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready);
    } catch {
      /* ignore */
    }
    const pageFonts = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const d = document as unknown as {
        fonts: { check: (f: string) => boolean; forEach: (cb: (f: { family: string; weight: string; status: string }) => void) => void };
      };
      const loaded: string[] = [];
      d.fonts.forEach((f) => loaded.push(`${f.family} ${f.weight}: ${f.status}`));
      return {
        headlineComputedFont: h1 ? getComputedStyle(h1).fontFamily : null,
        checkSourceSerif: d.fonts.check("16px 'Source Serif 4'"),
        checkInterTight: d.fonts.check("16px 'Inter Tight'"),
        registeredFaces: loaded,
      };
    });
    return { runtimeCwd: ROOT, fontDir: dir, fileChecks, htmlHasEmbeddedFont, pageFonts };
  } finally {
    await browser.close();
  }
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
