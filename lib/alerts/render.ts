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
  const [tpl, assets] = await Promise.all([loadTemplate(), loadAssets()]);
  return tpl(data)
    .replace("assets/granted-mark-navy.png", assets.navy)
    .replace("assets/granted-mark-white.png", assets.white);
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
    const pdf = await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
