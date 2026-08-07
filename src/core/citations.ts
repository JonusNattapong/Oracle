export type CitationKind = "memory" | "doc";

export interface Citation {
  ref: string;
  id: string;
  kind: CitationKind;
  label: string;
  freshness?: string;
  path?: string;
}

export interface CitationValidation {
  used: string[];
  unknown: string[];
}

/** Extract only the compact citation syntax Oracle emits in context blocks. */
export function extractCitationRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(m\d+|d\d+)\]/gi)].map((match) => match[1].toLowerCase()))];
}

export function validateCitations(text: string, citations: Citation[]): CitationValidation {
  const known = new Set(citations.map((citation) => citation.ref.toLowerCase()));
  const refs = extractCitationRefs(text);
  return {
    used: refs.filter((ref) => known.has(ref)),
    unknown: refs.filter((ref) => !known.has(ref)),
  };
}
