const DOCS_BASE = "https://docs.100monkeys.ai";
const FULL_DOCS_URL = `${DOCS_BASE}/llms-full.txt`;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedDocs: string | null = null;
let cacheTimestamp = 0;

async function fetchFullDocs(): Promise<string> {
  const now = Date.now();
  if (cachedDocs && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDocs;
  }

  const resp = await fetch(FULL_DOCS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch docs: ${resp.status}`);
  }
  cachedDocs = await resp.text();
  cacheTimestamp = now;
  return cachedDocs;
}

export interface DocsSearchResult {
  query: string;
  sections: Array<{
    title: string;
    content: string;
    url: string;
  }>;
  total_matches: number;
}

export async function searchDocs(query: string): Promise<DocsSearchResult> {
  const fullText = await fetchFullDocs();

  // Split into sections based on the llms-full.txt format
  const sections = splitIntoSections(fullText);

  // Simple keyword search — match sections containing query terms
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = sections
    .map((section) => {
      const lower = section.content.toLowerCase();
      const matchCount = queryTerms.filter((term) =>
        lower.includes(term),
      ).length;
      const score = matchCount / queryTerms.length;
      return { ...section, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // Top 5 results

  return {
    query,
    sections: scored.map((s) => ({
      title: s.title,
      content: s.content.slice(0, 2000), // Truncate long sections
      url: s.url,
    })),
    total_matches: scored.length,
  };
}

function splitIntoSections(
  text: string,
): Array<{ title: string; content: string; url: string }> {
  const parts: Array<{ title: string; content: string; url: string }> = [];

  // The llms-full.txt format uses "# Title" headings with [#slug] anchors
  const chunks = text.split(/(?=^# )/m);

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const firstLine = chunk.split("\n")[0].trim();
    const title = firstLine.replace(/^#+\s*/, "");

    // Extract slug from [#slug] anchor if present in the section
    const slugMatch = chunk.match(/\[#([^\]]+)\]/);
    const slug = slugMatch ? slugMatch[1] : "";
    const url = slug ? `${DOCS_BASE}/docs/${slug}` : `${DOCS_BASE}/docs`;

    parts.push({
      title: title || "Untitled",
      content: chunk,
      url,
    });
  }

  return parts;
}
