// missing_context, lesson 두 필드에만 적용 (오탐 위험 최소화)
const SENSITIVE_PATTERNS: RegExp[] = [
    // API 키류
    /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*\S{8,}/gi,
    // Bearer 토큰
    /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    // AWS 액세스 키
    /AKIA[0-9A-Z]{16}/g,
    // GitHub Personal Access Token
    /gh[pousr]_[A-Za-z0-9]{36,}/g,
    // 일반 secret / password 패턴
    /(?:password|secret|token|passwd)\s*[:=]\s*\S{4,}/gi,
    // 긴 hex 문자열 (32자 이상)
    /\b[0-9a-f]{32,}\b/gi,
    // Base64 스타일 긴 토큰 (40자 이상)
    /[A-Za-z0-9+/]{40,}={0,2}/g,
];

export function sanitize(text: string): string {
    let result = text;
    for (const pattern of SENSITIVE_PATTERNS) {
        result = result.replace(pattern, "[REDACTED]");
    }
    return result;
}

export function sanitizeRecord<T extends Record<string, unknown>>(record: T): T {
    const result = { ...record };
    for (const field of ["missing_context", "lesson"] as const) {
        if (field in result && typeof result[field] === "string") {
            (result as Record<string, unknown>)[field] = sanitize(result[field] as string);
        }
    }
    return result;
}
