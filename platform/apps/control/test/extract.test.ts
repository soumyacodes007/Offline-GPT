import { afterEach, beforeEach, expect, test } from "bun:test";
import { htmlToText } from "../src/knowledge/extract";
import { createHarness, json, type Harness } from "./harness";

/** A one-page PDF with the given text, built by hand so the test needs no fixtures. */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

let h: Harness;
let owner: string;
beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
});
afterEach(async () => {
  await h.close();
});

test("a PDF upload becomes searchable text", async () => {
  const base64 = Buffer.from(tinyPdf("Remote work allowance is 40 euros a month")).toString("base64");
  const upload = await h.call("POST", "/v1/knowledge/documents", { token: owner, body: { path: "policies/remote", title: "Remote work", file: { format: "pdf", base64 }, audience: [{ type: "role", id: "owner" }] } });
  expect(upload.status).toBe(201);
  const results = (await json(await h.call("POST", "/v1/knowledge/search", { token: owner, body: { query: "allowance" } }))).results as Array<{ text: string }>;
  expect(results[0]?.text).toContain("40 euros");
});

test("a damaged file is refused with a clear message", async () => {
  const response = await h.call("POST", "/v1/knowledge/documents", { token: owner, body: { path: "x", title: "x", file: { format: "pdf", base64: Buffer.from("not a pdf").toString("base64") } } });
  expect(response.status).toBe(400);
  expect(String((await json(response)).message)).toContain("couldn't be read");
});

test("Word headings become section headings", () => {
  const text = htmlToText("<h1>Expenses</h1><p>Keep receipts &amp; claim monthly.</p><h2>Travel</h2><p>Book trains first.</p>");
  expect(text).toBe("# Expenses\n\nKeep receipts & claim monthly.\n\n## Travel\n\nBook trains first.");
});
