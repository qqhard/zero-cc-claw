import matter from 'gray-matter';

export function chunkMarkdown(raw, { maxWords = 400, overlap = 50 } = {}) {
  const parsed = matter(raw);
  const body = parsed.content ?? raw;
  const sections = splitByHeading(body);
  const chunks = [];
  let idx = 0;
  for (const sec of sections) {
    for (const piece of slidingWindow(sec.text, maxWords, overlap)) {
      const headedText = sec.heading
        ? `# ${sec.heading}\n\n${piece}`
        : piece;
      chunks.push({
        chunkIdx: idx++,
        heading: sec.heading,
        text: headedText,
      });
    }
  }
  return chunks;
}

function splitByHeading(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (hasContent(current)) sections.push(current);
      current = { heading: m[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (hasContent(current)) sections.push(current);
  return sections.map((s) => ({
    heading: s.heading,
    text: s.lines.join('\n').trim(),
  }));
}

function hasContent(section) {
  return section.heading.length > 0 || section.lines.some((l) => l.trim().length > 0);
}

function tokenize(text) {
  const re = /[\u4e00-\u9fff\u3400-\u4dbf]|[^\s\u4e00-\u9fff\u3400-\u4dbf]+/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ text: m[0], index: m.index });
  return out;
}

function slidingWindow(text, maxWords, overlap) {
  const words = tokenize(text);
  if (words.length === 0) {
    return text.trim() ? [text] : [];
  }
  if (words.length <= maxWords) return [text];
  const out = [];
  const step = Math.max(1, maxWords - overlap);
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + maxWords, words.length);
    const sliceStart = words[start].index;
    const lastWord = words[end - 1];
    const sliceEnd = lastWord.index + lastWord.text.length;
    out.push(text.slice(sliceStart, sliceEnd));
    if (end >= words.length) break;
  }
  return out;
}
