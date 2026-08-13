// Minimal ambient declaration for `html-to-docx` (ships no types). We use exactly one call:
// (htmlString, headerHtml|null, options?) -> a Node Buffer of OOXML bytes. The upstream API can
// also resolve to a Blob in the browser, but this is only ever imported from a server-only module,
// so Buffer is the honest return type here. Options are typed loosely -- we pass a small, stable
// subset (footer/pageNumber/table) and the library ignores unknown keys.
declare module "html-to-docx" {
  interface HtmlToDocxOptions {
    title?: string;
    footer?: boolean;
    pageNumber?: boolean;
    table?: { row?: { cantSplit?: boolean } };
    [key: string]: unknown;
  }
  function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: HtmlToDocxOptions,
    footerHTMLString?: string | null,
  ): Promise<Buffer>;
  export default HTMLtoDOCX;
}
