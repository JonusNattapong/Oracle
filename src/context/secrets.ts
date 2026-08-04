import type { ContextFile } from "../types.js";

export interface SecretFinding {
  path: string;
  line: number;
  detector: string;
}

const TOKEN_DETECTORS = [
  { detector: "openai-api-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/ },
  { detector: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ }
];

const PLACEHOLDER_PATTERN = /^(?:["']?(?:your[-_ ]?|example[-_ ]?|sample[-_ ]?|test[-_ ]?)?(?:api[-_ ]?)?(?:key|token|secret|password)(?:[-_ ]?here)?["']?|<[^>]+>|\$\{[^}]+\}|process\.env\.[A-Z0-9_]+|undefined|null)$/i;
const ASSIGNMENT_PATTERN = /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret)\s*(=|:)\s*(.+?)\s*[,;]?\s*$/i;
/**
 * In TypeScript `:` introduces a type annotation, not a value — `accessToken: string`
 * in a signature is a parameter declaration, not a leaked credential. Only unquoted
 * values are exempt, so a real `"password": "string…"` in JSON still reports.
 */
const TYPE_ANNOTATION_PATTERN = /^(?:readonly\s+)?(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|Record|Array|Promise|Map|Set|Buffer)\b/;
/**
 * An unquoted dotted path (`data.access_token`, `config.auth.apiKey`) reads a secret from
 * somewhere else rather than embedding one. A dot is required so a bare `PASSWORD=hunter2`
 * still reports — that shape is a real leak, not a reference.
 */
const REFERENCE_PATTERN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/;

export function scanFilesForSecrets(files: ContextFile[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(line)) {
        findings.push({ path: file.path, line: index + 1, detector: "private-key" });
        continue;
      }

      const tokenDetector = TOKEN_DETECTORS.find(({ pattern }) => pattern.test(line));
      if (tokenDetector) {
        findings.push({ path: file.path, line: index + 1, detector: tokenDetector.detector });
        continue;
      }

      const assignment = line.match(ASSIGNMENT_PATTERN);
      if (assignment) {
        const raw = assignment[2].trim();
        if (assignment[1] === ":" && TYPE_ANNOTATION_PATTERN.test(raw)) continue;
        if (REFERENCE_PATTERN.test(raw)) continue;
        const value = raw.replace(/^["']|["']$/g, "");
        if (value.length >= 8 && !PLACEHOLDER_PATTERN.test(value)) {
          findings.push({ path: file.path, line: index + 1, detector: "sensitive-assignment" });
        }
      }
    }
  }
  return findings;
}
