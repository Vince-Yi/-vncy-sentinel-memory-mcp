#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";
import { sanitizeRecord } from "./sanitizer.js";

const DEFAULT_COMPACT_THRESHOLD = 50;

const server = new McpServer({
    name: "sentinel-memory",
    version: "1.0.0",
});

function nowIso(): string {
    return new Date().toISOString();
}

function formatRecords(records: store.MemoryRecord[]): string {
    const lines: string[] = [`[memory_log - ${records.length}건]\n`];

    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const created = r.meta.created.slice(0, 10);

        let header: string;
        if (r.type === "principle") {
            const compactedAt = (r.meta.compacted_at ?? "").slice(0, 10);
            const sourceCount = r.meta.source_count ?? "?";
            header = `#${i + 1} type=principle | topic=${r.topic} | compacted: ${compactedAt} (${sourceCount}건 통합)`;
        } else {
            header = `#${i + 1} type=log | topic=${r.topic} | ${created}`;
        }

        const block: string[] = [header];
        if (r.missing_context) block.push(`missing_context: ${r.missing_context}`);
        block.push(`lesson: ${r.lesson}`);
        if (r.ask_next_time) block.push(`ask_next_time: ${r.ask_next_time}`);
        lines.push(block.join("\n"));
    }

    return lines.join("\n\n");
}

function formatCompactGroups(records: store.MemoryRecord[]): string {
    const groups = new Map<string, store.MemoryRecord[]>();
    for (const r of records) {
        const topic = r.topic || "unknown";
        if (!groups.has(topic)) groups.set(topic, []);
        groups.get(topic)!.push(r);
    }

    const topics = [...groups.keys()].sort();
    const lines: string[] = [
        `[compact 대상 - 총 ${records.length}건 / ${topics.length}개 topic]\n`,
        "※ 유사한 topic이 있으면 통합하고, lesson을 핵심 원칙 1문장으로 요약 후",
        "   log_memory(type='principle', ...)를 호출하세요.\n",
    ];

    for (const topic of topics) {
        const group = groups.get(topic)!;
        lines.push(`── topic: ${topic} (${group.length}건) ──`);
        for (const r of group) {
            lines.push(`  [id=${r.id}]`);
            if (r.missing_context) lines.push(`  missing_context: ${r.missing_context}`);
            lines.push(`  lesson: ${r.lesson}`);
            if (r.ask_next_time) lines.push(`  ask_next_time: ${r.ask_next_time}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
    "search_memory",
    "[작업 시작 전 필수 호출] 과거 기록을 조회한다. 반환된 전체 내용을 바탕으로 현재 작업과 관련 있는 lesson / ask_next_time을 직접 판단하라.",
    {
        query: z.string().describe("현재 작업 설명 또는 검색 키워드"),
        topic: z.string().optional().describe("지정 시 해당 topic과 완전 일치하는 기록만 반환"),
    },
    async ({ topic }) => {
        const filterTopic = topic?.trim() || undefined;
        const { records, skipped } = await store.readAll(filterTopic);

        const warn = skipped ? `⚠ 손상된 줄 ${skipped}개 스킵됨\n\n` : "";

        if (!records.length) {
            const scope = filterTopic ? ` (topic=${filterTopic})` : "";
            return {
                content: [{
                    type: "text" as const,
                    text:
                        warn +
                        `관련된 과거 기록이 없습니다${scope}.\n` +
                        "사용자에게 다음을 질문하십시오:\n" +
                        "1. 이 모듈의 핵심 제약사항이 있나요?\n" +
                        "2. 의존하는 외부 라이브러리 버전 요구사항이 있나요?\n" +
                        "3. 이전에 시도했다가 실패한 방식이 있나요?",
                }],
            };
        }

        return {
            content: [{ type: "text" as const, text: warn + formatRecords(records) }],
        };
    }
);

server.tool(
    "log_memory",
    "[작업 완료 후 필수 호출] 작업에서 발견한 지식을 기록한다.",
    {
        topic: z.string().describe("작업 주제 태그 (예: auth, payment, api-gateway)"),
        missing_context: z.string().describe("초기 지시에서 누락됐으나 필수였던 정보"),
        lesson: z.string().describe("다음 작업 시 반드시 적용해야 할 규칙·제약"),
        ask_next_time: z.string().optional().describe("다음 작업 시작 전 사용자에게 던질 확인 질문"),
        type: z.enum(["log", "principle"]).optional().describe("'log'(기본) 또는 'principle'(Compact 결과)"),
        compact_threshold: z.number().int().optional().describe("Compact 기준 건수 (기본 50)"),
    },
    async ({
        topic,
        missing_context,
        lesson,
        ask_next_time = "",
        type = "log",
        compact_threshold = DEFAULT_COMPACT_THRESHOLD,
    }) => {
        const trimmedTopic = topic.trim();
        const id =
            type === "principle"
                ? store.contentId(trimmedTopic, lesson)
                : store.contentId(trimmedTopic, missing_context);

        const now = nowIso();
        const record: store.MemoryRecord = {
            id,
            type,
            topic: trimmedTopic,
            missing_context,
            lesson,
            ask_next_time,
            meta: {
                created: now,
                ...(type === "principle" ? { compacted_at: now } : {}),
            },
        };

        const sanitized = sanitizeRecord(record as unknown as Record<string, unknown>) as unknown as store.MemoryRecord;
        await store.upsertLog(sanitized);

        const currentCount = await store.count();
        let msg = `저장 완료: topic=${trimmedTopic} | 현재 ${currentCount}건`;
        if (currentCount > compact_threshold) {
            msg +=
                `\n\n⚠ 기록이 ${currentCount}건으로 임계값(${compact_threshold})을 초과했습니다.` +
                "\n[필수] compact_memory를 호출하여 지식을 압축하십시오.";
        }

        return { content: [{ type: "text" as const, text: msg }] };
    }
);

server.tool(
    "compact_memory",
    "[기록 50건 초과 시 필수 호출] topic별로 그루핑된 기록 목록을 반환한다. 반환 결과를 바탕으로 유사 topic 통합 → lesson 요약 → log_memory(type='principle') 저장 → compact_memory_delete 순서로 작업하라.",
    {
        target_topic: z.string().optional().describe("지정 시 해당 topic만 처리 (완전 일치)"),
        compact_threshold: z.number().int().optional().describe("Compact 기준 건수 (기본 50)"),
    },
    async ({ target_topic, compact_threshold = DEFAULT_COMPACT_THRESHOLD }) => {
        const filterTopic = target_topic?.trim() || undefined;
        const { records, skipped } = await store.readAll(filterTopic);

        const warn = skipped ? `⚠ 손상된 줄 ${skipped}개 스킵됨\n\n` : "";
        const logRecords = records.filter((r) => r.type === "log");

        if (records.length <= compact_threshold && !filterTopic) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        warn +
                        `현재 기록 ${records.length}건으로 임계값(${compact_threshold}) 이하입니다. Compact가 필요하지 않습니다.`,
                }],
            };
        }

        if (!logRecords.length) {
            return {
                content: [{ type: "text" as const, text: warn + "압축할 log 타입 기록이 없습니다." }],
            };
        }

        return {
            content: [{ type: "text" as const, text: warn + formatCompactGroups(logRecords) }],
        };
    }
);

server.tool(
    "compact_memory_delete",
    "[compact_memory 후, principle 저장 성공 확인 후에만 호출] 원본 log 기록을 삭제한다. compact_memory가 반환한 id 목록만 전달하라.",
    {
        ids: z.array(z.string()).describe("삭제할 기록의 id 목록 (compact 호출 시점의 스냅샷 기준)"),
    },
    async ({ ids }) => {
        if (!ids.length) {
            return { content: [{ type: "text" as const, text: "삭제할 id 목록이 비어있습니다." }] };
        }
        const deleted = await store.deleteByIds(ids);
        return {
            content: [{
                type: "text" as const,
                text: `삭제 완료: ${deleted}건 삭제됨 (요청 ${ids.length}건 중)`,
            }],
        };
    }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
