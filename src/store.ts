import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const MEMORY_LOG_PATH = path.join(process.cwd(), ".context", "memory_log.jsonl");
const LOCK_PATH = MEMORY_LOG_PATH + ".lock";

const BYTE_LIMITS: Record<string, number> = {
    topic: 64,
    missing_context: 1024,
    lesson: 1024,
    ask_next_time: 512,
};

export interface MemoryRecord {
    id: string;
    type: "log" | "principle";
    topic: string;
    missing_context: string;
    lesson: string;
    ask_next_time: string;
    meta: {
        created: string;
        compacted_at?: string;
        source_count?: number;
    };
}

function byteLength(str: string): number {
    return Buffer.byteLength(str, "utf-8");
}

function validate(record: Partial<MemoryRecord>): void {
    const topic = record.topic?.trim() ?? "";
    if (!topic) {
        throw new Error("topic은 필수이며 공백만 있는 값은 허용하지 않습니다.");
    }
    for (const [field, limit] of Object.entries(BYTE_LIMITS)) {
        const value = (record as Record<string, string>)[field] ?? "";
        if (value && byteLength(value) > limit) {
            throw new Error(
                `'${field}' 필드가 UTF-8 ${limit} bytes 상한을 초과합니다. (실제: ${byteLength(value)} bytes)`
            );
        }
    }
}

export function contentId(topic: string, keyField: string): string {
    return crypto.createHash("sha256").update(topic + keyField, "utf-8").digest("hex").slice(0, 16);
}

async function acquireLock(): Promise<void> {
    // .context/ 디렉토리가 없으면 자동 생성
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            fs.mkdirSync(LOCK_PATH);
            return;
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code !== "EEXIST") throw e;

            // 스테일 락 감지: 30초 이상 된 락 디렉터리는 강제 제거
            try {
                const stat = fs.statSync(LOCK_PATH);
                if (Date.now() - stat.mtimeMs > 30_000) {
                    fs.rmdirSync(LOCK_PATH);
                    continue;
                }
            } catch { /* 무시 */ }

            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error("파일 락 획득 실패: 5초 타임아웃");
}

function releaseLock(): void {
    try {
        fs.rmdirSync(LOCK_PATH);
    } catch { /* 무시 */ }
}

async function withLock<T>(fn: () => T): Promise<T> {
    await acquireLock();
    try {
        return fn();
    } finally {
        releaseLock();
    }
}

function readLines(): { records: MemoryRecord[]; skipped: number } {
    if (!fs.existsSync(MEMORY_LOG_PATH)) return { records: [], skipped: 0 };

    const records: MemoryRecord[] = [];
    let skipped = 0;
    const lines = fs.readFileSync(MEMORY_LOG_PATH, "utf-8").split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            records.push(JSON.parse(line) as MemoryRecord);
        } catch {
            console.error(`[sentinel-memory] memory_log.jsonl ${i + 1}번째 줄 파싱 실패 — 스킵`);
            skipped++;
        }
    }
    return { records, skipped };
}

function writeLines(records: MemoryRecord[]): void {
    const dir = path.dirname(MEMORY_LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(6).toString("hex")}.jsonl`);
    try {
        const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
        fs.writeFileSync(tmpPath, content, "utf-8");
        fs.renameSync(tmpPath, MEMORY_LOG_PATH);
    } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { /* 무시 */ }
        throw e;
    }
}

export async function upsertLog(record: MemoryRecord): Promise<void> {
    validate(record);
    await withLock(() => {
        const { records } = readLines();
        const idx = records.findIndex((r) => r.id === record.id);
        if (idx >= 0) {
            records[idx] = record;
        } else {
            records.push(record);
        }
        writeLines(records);
    });
}

export async function deleteByIds(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const idSet = new Set(ids);
    return withLock(() => {
        const { records } = readLines();
        const remaining = records.filter((r) => !idSet.has(r.id));
        writeLines(remaining);
        return records.length - remaining.length;
    });
}

export async function readAll(
    topic?: string
): Promise<{ records: MemoryRecord[]; skipped: number }> {
    return withLock(() => {
        const { records, skipped } = readLines();
        if (topic !== undefined) {
            return { records: records.filter((r) => r.topic === topic), skipped };
        }
        return { records, skipped };
    });
}

export async function count(): Promise<number> {
    return withLock(() => readLines().records.length);
}
