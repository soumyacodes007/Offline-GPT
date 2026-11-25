import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { PDFiumLibrary } from "@hyzyla/pdfium"
import { strFromU8, unzipSync } from "fflate"

/**
 * Turns an uploaded PDF, Word (.docx), Markdown or text file into Markdown the
 * knowledge base can split into sections. Everything runs in-process: PDFium
 * (Chrome's PDF engine, as WebAssembly) for PDFs, and the .docx XML read
 * directly, so nothing leaves the deployment. Each PDF page and each Word
 * heading becomes its own section, so it can be labelled or restricted alone.
 */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const knowledgeSourceMimeTypes = ["text/markdown", "text/plain", "application/pdf", DOCX_MIME] as const
export type KnowledgeSourceMime = (typeof knowledgeSourceMimeTypes)[number]

export class KnowledgeExtractError extends Error {}

type Pdfium = Awaited<ReturnType<typeof PDFiumLibrary.init>>
let pdfium: Promise<Pdfium> | null = null
let queue: Promise<unknown> = Promise.resolve()

function loadPdfium() {
  pdfium ??= readFile(createRequire(import.meta.url).resolve("@hyzyla/pdfium/pdfium.wasm"))
    .then((bytes) => PDFiumLibrary.init({ wasmBinary: Uint8Array.from(bytes).buffer }))
    .catch((cause: unknown) => {
      pdfium = null
      throw cause
    })
  return pdfium
}

function tidy(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** PDFium shares one wasm heap, so documents are read one at a time. */
function pdfToMarkdown(bytes: Uint8Array): Promise<string> {
  const run = queue.then(async () => {
    const library = await loadPdfium()
    let document
    try {
      document = await library.loadDocument(bytes)
    } catch {
      throw new KnowledgeExtractError("This PDF can't be opened. It may be damaged or password protected.")
    }
    try {
      const pages: string[] = []
      for (let index = 0; index < document.getPageCount(); index += 1) {
        const text = tidy(document.getPage(index).getText())
        if (text) pages.push(`## Page ${index + 1}\n\n${text}`)
      }
      if (pages.length === 0) throw new KnowledgeExtractError("This PDF has no text to read. If it is a scan, run it through OCR first.")
      return pages.join("\n\n")
    } finally {
      document.destroy()
    }
  })
  queue = run.catch(() => undefined)
  return run
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }
function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
    code.startsWith("#x") || code.startsWith("#X") ? String.fromCodePoint(Number.parseInt(code.slice(2), 16))
      : code.startsWith("#") ? String.fromCodePoint(Number.parseInt(code.slice(1), 10))
        : entities[code.toLowerCase()] ?? "")
}

/** Paragraph text from word/document.xml; Title and Heading N styles become Markdown headings. */
function docxToMarkdown(bytes: Uint8Array): string {
  let xml: string
  try {
    const files = unzipSync(bytes, { filter: (file) => file.name === "word/document.xml" })
    const documentXml = files["word/document.xml"]
    if (!documentXml) throw new Error("missing word/document.xml")
    xml = strFromU8(documentXml)
  } catch {
    throw new KnowledgeExtractError("This Word file can't be opened. Save it as .docx and try again.")
  }
  const blocks: string[] = []
  for (const [, paragraph] of xml.matchAll(/<w:p[ >]([\s\S]*?)<\/w:p>/g)) {
    const text = decodeXml(paragraph
      .replace(/<w:tab\/>/g, "\u0000\t\u0000")
      .replace(/<w:(br|cr)\/>/g, "\u0000\n\u0000")
      .replace(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g, "\u0000$1\u0000")
      .split("\u0000")
      .filter((_, index) => index % 2 === 1)
      .join("")).trim()
    if (!text) continue
    const style = /<w:pStyle w:val="([^"]+)"/.exec(paragraph)?.[1] ?? ""
    const level = style === "Title" ? 1 : Number(/^Heading(\d)$/i.exec(style)?.[1] ?? 0)
    blocks.push(level > 0 ? `${"#".repeat(Math.min(level, 6))} ${text}` : text)
  }
  if (blocks.length === 0) throw new KnowledgeExtractError("This Word file has no text.")
  return blocks.join("\n\n")
}

export function detectKnowledgeSource(fileName: string, bytes: Uint8Array): KnowledgeSourceMime | null {
  const lower = fileName.toLowerCase()
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString("latin1")
  if (lower.endsWith(".pdf") || head.includes("%PDF-")) return "application/pdf"
  if (lower.endsWith(".docx")) return DOCX_MIME
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown"
  if (lower.endsWith(".txt")) return "text/plain"
  return null
}

export async function extractKnowledgeText(fileName: string, bytes: Uint8Array): Promise<{ text: string; mimeType: KnowledgeSourceMime }> {
  const mimeType = detectKnowledgeSource(fileName, bytes)
  if (!mimeType) throw new KnowledgeExtractError("Upload a PDF, Word (.docx), Markdown or text file.")
  if (mimeType === "application/pdf") return { text: await pdfToMarkdown(bytes), mimeType }
  if (mimeType === DOCX_MIME) return { text: docxToMarkdown(bytes), mimeType }
  const text = tidy(new TextDecoder().decode(bytes))
  if (!text) throw new KnowledgeExtractError("This file is empty.")
  return { text, mimeType }
}
