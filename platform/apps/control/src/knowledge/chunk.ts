export type Section = { heading: string; body: string };

const MAX_SECTION_CHARS = 1200;

function splitLong(heading: string, body: string): Section[] {
  if (body.length <= MAX_SECTION_CHARS) return [{ heading, body }];
  const parts: Section[] = [];
  let current = "";
  for (const paragraph of body.split(/\n\s*\n/)) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && next.length > MAX_SECTION_CHARS) {
      parts.push({ heading, body: current });
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) parts.push({ heading, body: current });
  // A single paragraph longer than the limit is cut at the limit.
  return parts.flatMap((part) => {
    if (part.body.length <= MAX_SECTION_CHARS) return [part];
    const pieces: Section[] = [];
    for (let start = 0; start < part.body.length; start += MAX_SECTION_CHARS) pieces.push({ heading, body: part.body.slice(start, start + MAX_SECTION_CHARS) });
    return pieces;
  });
}

/** Split Markdown or plain text into sections at headings, then at paragraph breaks when a section is long. */
export function splitIntoSections(title: string, text: string): Section[] {
  const sections: Section[] = [];
  let heading = title;
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) sections.push(...splitLong(heading, body));
    lines = [];
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (match?.[2]) {
      flush();
      heading = match[2];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}
