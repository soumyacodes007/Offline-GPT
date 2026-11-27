import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export type UploadFormat = "text" | "pdf" | "docx";

/** Turn an uploaded file into text the section splitter understands. Runs inside the network; nothing is sent out. */
export async function extractUploadText(format: UploadFormat, data: Uint8Array): Promise<string> {
  switch (format) {
    case "text":
      return new TextDecoder().decode(data);
    case "pdf": {
      const pdf = await getDocumentProxy(data);
      const { text } = await extractText(pdf, { mergePages: false });
      return text.map((page) => page.trim()).filter(Boolean).join("\n\n");
    }
    case "docx": {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
      return htmlToText(result.value);
    }
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Word headings become Markdown headings, so sections split where the author split them. */
export function htmlToText(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_match, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`)
    .replace(/<\/(p|li|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
