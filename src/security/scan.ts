export interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  message: string;
  file?: string;
  line?: number;
}

const SECRET_PATTERNS: Array<[RegExp, string, 'high' | 'medium' | 'low']> = [
  [/sk-[A-Za-z0-9]{20,}/, 'Hardcoded API key (OpenAI-style).', 'high'],
  [/AKIA[0-9A-Z]{16}/, 'Hardcoded AWS access key.', 'high'],
  [/(api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/i, 'Hardcoded credential in source.', 'high'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/i, 'Hardcoded bearer token.', 'high'],
  [/(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/, 'Private key material in repository.', 'high'],
  [/(mongodb\+srv|postgres(ql)?|mysql|redis):[/][^'"\s]+[/][^'"\s]+:[^'"\s]+@/i, 'Database connection string with embedded credentials.', 'high']
];

const RISK_PATTERNS: Array<[RegExp, string, 'medium' | 'low']> = [
  [/\.innerHTML\s*=/, 'Potential XSS via innerHTML assignment.', 'medium'],
  [/eval\(/, 'Use of eval() can allow code injection.', 'medium'],
  [/child_process\.exec/, 'Shell exec used; validate inputs to avoid injection.', 'low'],
  [/<script\b[\s>]/i, 'Inline script tag (potential XSS surface).', 'low'],
  [/SELECT\s+.*\s+FROM\s+.*(['"]\s*\+\s*['"])/, 'Possible SQL injection via string concatenation.', 'medium'],
  [/password\s*[=:]/i, 'Password field found; ensure hashing/validation.', 'low'],
  [/localStorage/, 'Data stored in localStorage may be misused by XSS.', 'low']
];

export class SecurityScanner {
  scanFile(content: string, file: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');
    for (const [rx, message, severity] of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          findings.push({ severity, message, file, line: i + 1 });
          break;
        }
      }
    }
    for (const [rx, message, severity] of RISK_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          findings.push({ severity, message, file, line: i + 1 });
          break;
        }
      }
    }
    return findings;
  }

  scanFiles(
    files: Array<{ path: string; content: string }>
  ): { high: SecurityFinding[]; medium: SecurityFinding[]; low: SecurityFinding[] } {
    const all: SecurityFinding[] = [];
    for (const f of files) {
      all.push(...this.scanFile(f.content, f.path));
    }
    all.sort((a, b) => {
      const o = { high: 0, medium: 1, low: 2 };
      return o[a.severity] - o[b.severity];
    });
    return {
      high: all.filter((f) => f.severity === 'high'),
      medium: all.filter((f) => f.severity === 'medium'),
      low: all.filter((f) => f.severity === 'low')
    };
  }
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***')
    .replace(/AKIA[0-9A-Z]{8,}/g, 'AKIA***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/(api[_-]?key\s*[:=]\s*['"]?)[^'"\s]{8,}/gi, '$1***');
}