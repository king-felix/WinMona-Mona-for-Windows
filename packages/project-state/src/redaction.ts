/**
 * One local redaction utility shared by the memory index, settings backups,
 * portable handoff and diagnostic bundles. It is intentionally conservative:
 * it removes credential-shaped values and the account name in home paths, and
 * it leaves content digests (hex sha256) alone because those are evidence.
 *
 * Redaction is not a security boundary by itself; callers must also avoid
 * collecting secrets. This module makes an accidental inclusion visible and
 * keeps it out of the artifact.
 */

export type RedactionReport = {
  text: string;
  /** Number of matched spans replaced. */
  redactions: number;
  /** Rule names that fired, so a diagnostic bundle can say what was removed. */
  rules: string[];
};

type Rule = { name: string; pattern: RegExp; replacement: string | ((match: string, ...groups: string[]) => string) };

const RULES: Rule[] = [
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    replacement: 'Bearer [redacted]',
  },
  {
    name: 'authorization-header',
    pattern: /((?:authorization|proxy-authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: (_match, prefix) => `${prefix}[redacted]`,
  },
  {
    name: 'credential-assignment',
    pattern:
      /((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|runtime[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|credential|secret|token)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: (_match, prefix) => `${prefix}[redacted]`,
  },
  {
    name: 'url-token-query',
    pattern: /([?&](?:token|api_key|apikey|key|secret|access_token|auth|password)=)[^&\s]+/gi,
    replacement: (_match, prefix) => `${prefix}[redacted]`,
  },
  {
    name: 'url-userinfo',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replacement: (_match, prefix) => `${prefix}[redacted]@`,
  },
  {
    name: 'provider-key',
    pattern: /\b(?:sk|rk|pk)[-_][A-Za-z0-9]{12,}\b/g,
    replacement: '[redacted]',
  },
  {
    name: 'env-token',
    pattern: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)=("[^"]*"|'[^']*'|[^\s]+)/g,
    replacement: (_match) => '[redacted]',
  },
  {
    name: 'user-home-path',
    // Keep the shape recognizable but drop the account name.
    pattern: /((?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/))[^\\/\s:"']+/g,
    replacement: (_match, prefix) => `${prefix}[user]`,
  },
];

export function redactText(text: string): RedactionReport {
  let value = text;
  let redactions = 0;
  const rules: string[] = [];
  for (const rule of RULES) {
    const matches = value.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    redactions += matches.length;
    rules.push(rule.name);
    value = value.replace(rule.pattern, rule.replacement as string);
  }
  return { text: value, redactions, rules };
}

export function redactSecretText(text: string): string {
  return redactText(text).text;
}

const SECRET_KEY =
  /(api[_-]?key|access[_-]?key|secret|password|passwd|credential|authorization|cookie|private[_-]?key|token)/i;

export type ValueRedaction = {
  value: unknown;
  /** Dot paths whose value was replaced because the key or value looked secret. */
  redactedPaths: string[];
  /** Rule names that fired, deduplicated. */
  rules: string[];
};

/**
 * Recursively redact a settings-shaped value. A key that names a credential is
 * replaced wholesale; every other string still passes through text redaction,
 * because a token can hide in a URL or a free-form value.
 */
export function redactValue(input: unknown, options: { maxDepth?: number } = {}): ValueRedaction {
  const maxDepth = options.maxDepth ?? 8;
  const redactedPaths = new Set<string>();
  const rules = new Set<string>();
  const seen = new Set<object>();

  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value === 'string') {
      const report = redactText(value);
      if (report.redactions > 0) {
        redactedPaths.add(path || '(root)');
        for (const rule of report.rules) rules.add(rule);
      }
      return report.text;
    }
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= maxDepth) {
      redactedPaths.add(path || '(root)');
      return '[omitted: nesting depth]';
    }
    if (seen.has(value)) {
      redactedPaths.add(path || '(root)');
      return '[omitted: cycle]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 500).map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY.test(key)) {
        result[key] = '[redacted]';
        redactedPaths.add(childPath);
        rules.add('secret-key-name');
        continue;
      }
      result[key] = walk(source[key], childPath, depth + 1);
    }
    return result;
  };

  return {
    value: walk(input, '', 0),
    redactedPaths: [...redactedPaths].sort(),
    rules: [...rules].sort(),
  };
}

/** True when a relative path looks like a credential store rather than content. */
export function looksLikeSecretPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  if (/^\.env(\.|$)/.test(name)) return true;
  if (/^(\.npmrc|\.git-credentials|\.pgpass|credentials|id_rsa|id_ed25519|id_ecdsa)$/.test(name)) return true;
  if (/\.(pem|key|pfx|p12|jks|keystore)$/.test(name)) return true;
  if (name === 'auth.json' || name === 'secrets.json' || name === 'credentials.json') return true;
  return false;
}
