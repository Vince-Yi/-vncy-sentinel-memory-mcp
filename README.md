# Sentinel-Memory MCP

A lightweight MCP server that records and reuses **Prompt Gaps** — essential context missing from initial instructions — so your AI assistant learns from every session.

No vector databases. No ML models. Just a plain JSONL file tracked by Git.

---

## How It Works

Every time your AI assistant works on a task, it encounters information that was never in the original instructions but turned out to be critical. Sentinel-Memory captures those gaps and surfaces them automatically at the start of the next related task.

```
[Before task]  search_memory()        →  past lessons + questions to ask
[After task]   log_memory()           →  what was missing, what to remember
[When full]    compact_memory()       →  group logs by topic for Claude to summarize
               compact_memory_delete() →  remove originals after principle is saved
```

Memory is stored in `.context/memory_log.jsonl` inside your project — a plain text file you can read, diff, and commit like any other source file.

---

## Features

- **Zero ML dependencies** — no embeddings, no model downloads
- **Git-native storage** — plain JSONL, human-readable, fully diffable
- **Claude judges relevance** — returns all records; Claude picks what matters
- **Topic normalization** — similar topics merged during compaction
- **Atomic writes** — temp file + rename, safe against crashes
- **Cross-platform file locking** — directory-based lock, works on Windows and Linux
- **Sensitive data filtering** — API keys and tokens redacted before storage
- **npx-ready** — no installation required once published to npm

---

## Requirements

- Node.js 18+
- An MCP-compatible client (Cursor, Claude Code, etc.)

---

## Installation

### Option A — npx (after npm publish, no installation needed)

Copy `.cursor/mcp.json.example` to `.cursor/mcp.json` in your project:

```json
{
    "mcpServers": {
        "sentinel-memory": {
            "command": "npx",
            "args": ["-y", "@vncy/sentinel-memory-mcp"]
        }
    }
}
```

Cursor automatically sets the working directory to the workspace root when launching MCP servers, so no `cwd` is needed. `.context/memory_log.jsonl` is created in the project root on first use.

### Option B — local build

```bash
git clone https://github.com/your-org/dug-sentinel-memory-mcp.git
cd dug-sentinel-memory-mcp
npm install
npm run build
```

Then reference the built file directly in `.cursor/mcp.json`:

```json
{
    "mcpServers": {
        "sentinel-memory": {
            "command": "node",
            "args": ["/absolute/path/to/dug-sentinel-memory-mcp/dist/server.js"]
        }
    }
}
```

> `.cursor/mcp.json` is listed in `.gitignore`. Copy `.cursor/mcp.json.example` and edit locally — no need to commit your personal paths.

---

## Project path per developer

Each developer keeps their own `.cursor/mcp.json` (git-ignored). Cursor sets the working directory to the workspace root automatically, so every developer gets their own `.context/` without any path configuration.

```
Developer A  opens ProjectA  →  MCP CWD = ProjectA/  →  ProjectA/.context/memory_log.jsonl
Developer B  opens ProjectB  →  MCP CWD = ProjectB/  →  ProjectB/.context/memory_log.jsonl
```

---

## Tools

### `search_memory(query, topic?)`

Call this **before starting any task**. Returns all past records (filtered by topic if specified). Claude reads the output and selects relevant lessons.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Task description or keywords |
| `topic` | string (optional) | Exact-match topic filter |

### `log_memory(topic, missing_context, lesson, ask_next_time?, type?, compact_threshold?)`

Call this **after completing any task**. Records what was missing and what to remember.

| Parameter | Type | Description |
|-----------|------|-------------|
| `topic` | string | Module/feature tag (e.g. `auth`, `payment`) |
| `missing_context` | string | Info absent from original instructions but critical |
| `lesson` | string | Rule to apply in future tasks |
| `ask_next_time` | string (optional) | Question to ask the user next time |
| `type` | string (optional) | `"log"` (default) or `"principle"` (compacted) |
| `compact_threshold` | int (optional) | Compaction trigger count (default: 50) |

### `compact_memory(target_topic?, compact_threshold?)`

Call this **when record count exceeds the threshold**. Returns grouped records for Claude to summarize into principles.

### `compact_memory_delete(ids)`

Call this **only after** `log_memory(type="principle")` succeeds. Deletes the original log records by id.

---

## Workflow (.cursorrules)

The `.cursorrules` file enforces the 3-step loop for every task:

```
You are the Memory Manager for this project.
All tasks are grounded in .context/memory_log.jsonl.

IMPORTANT: Do NOT write any code or edit any file before completing Step 1.

[Before every task — REQUIRED]
1. Call search_memory with a description of the current task.
2. Read the returned records and identify lessons relevant to this task.
3. If relevant records exist:
   - Apply the lessons directly to your approach.
   - Ask the user the questions listed in ask_next_time before proceeding.
4. If no relevant records exist:
   - Do not guess constraints. Ask the user about key requirements first.

[After every task — REQUIRED]
5. Call log_memory with:
   - missing_context  ←  info absent from the initial instructions but turned out critical
   - lesson           ←  rule to apply in future tasks of this type
   - ask_next_time    ←  question to ask the user before starting similar tasks

[Topic naming rules]
- Use module- or feature-level granularity (language/framework agnostic).
- Good examples : auth, payment, api-gateway, ui-form, db-migration
- Too narrow (forbidden) : login_bug_fix_2026, verify_token_v2
- Too broad  (forbidden) : code, backend, fix
- Check existing topics first. Reuse a close match instead of creating a new one.
  e.g. if "auth-login" exists, use it instead of creating "authentication"

[Compaction — REQUIRED when record count exceeds 50]
6.  Call compact_memory to receive records grouped by topic.
7.  Merge similar topics (e.g. "auth", "auth-login" → "auth").
8.  Summarize each topic's lessons into one concise sentence.
9.  Merge each topic's ask_next_time values; keep under 512 bytes total.
10. Call log_memory(type="principle", ...) to store the summary.
11. After confirming the principle is saved, call compact_memory_delete(ids=[...]) to remove originals.

Skipping any step in this sequence is not allowed.
```

---

## Data format

Records are stored one JSON object per line in `.context/memory_log.jsonl`.

**Log record:**
```json
{
    "id": "a1b2c3d4e5f6a7b8",
    "type": "log",
    "topic": "payment",
    "missing_context": "VAT rates differ by country — not mentioned in the brief",
    "lesson": "Always check the country-specific tax rate file before modifying payment logic",
    "ask_next_time": "Which countries does this change apply to?",
    "meta": { "created": "2026-02-27T10:30:00.000Z" }
}
```

**Principle record (after compaction):**
```json
{
    "id": "b2c3d4e5f6a7b8c9",
    "type": "principle",
    "topic": "payment",
    "missing_context": "",
    "lesson": "Payment module: verify country tax rates, keep refund API separate, PG timeout is 10s",
    "ask_next_time": "Which countries apply? Which payment gateway?",
    "meta": {
        "created": "2026-03-15T09:00:00.000Z",
        "compacted_at": "2026-03-15T09:00:00.000Z",
        "source_count": 7
    }
}
```

| Field | Limit | On exceed |
|-------|-------|-----------|
| `topic` | 64 bytes (UTF-8) | Error |
| `missing_context` | 1,024 bytes (UTF-8) | Error |
| `lesson` | 1,024 bytes (UTF-8) | Error |
| `ask_next_time` | 512 bytes (UTF-8) | Error |

---

## File structure

```
your-project/
├── .cursor/
│   ├── mcp.json              ← git-ignored, copy from mcp.json.example
│   └── mcp.json.example      ← committed template
└── .context/
    └── memory_log.jsonl      ← auto-created, commit this file

dug-sentinel-memory-mcp/      ← this repository
├── src/
│   ├── server.ts             ← MCP tools (4 tools)
│   ├── store.ts              ← JSONL CRUD + file lock + atomic write
│   └── sanitizer.ts          ← sensitive data filter
├── dist/                     ← compiled output (generated by npm run build)
├── .cursor/
│   └── mcp.json.example      ← configuration template
├── docs/
│   ├── Design.md
│   └── Design_KR.md
├── package.json
├── tsconfig.json
├── .cursorrules
└── .gitignore
```

---

## Security notes

- `missing_context` and `lesson` fields are scanned for API keys, tokens, and secrets before storage. Detected patterns are replaced with `[REDACTED]`.
- `.context/memory_log.jsonl` is plain text. Review `git diff .context/` before pushing to a shared repository.
- For sensitive projects, add `.context/` to `.gitignore`.

---

## License

MIT
