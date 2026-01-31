# Skill: recall

## Description

Search across all personal data using natural language. This skill provides unified search over journal entries, knowledge graph nodes, project issues, specifications, and conversation history. It uses semantic vector search when embeddings are available, and falls back to text-based search otherwise.

## When to Activate

Activate this skill automatically when the user expresses search or recall intent. Common triggers include:

- "Find..." or "Search for..."
- "Remember when..." or "What was that thing about..."
- "What did I say about..."
- "Do I have anything on..."
- "Look up..." or "Can you find..."
- Any question that requires searching across the user's stored data

This skill does not require a slash command prefix. It activates whenever the user appears to be searching their personal data.

## Available Tools

- `mcp__pg__query` -- Execute SQL queries against the PostgreSQL database.
- `embed_query` -- Convert a text string into a vector embedding for semantic search. Accepts `{ text: "search query" }` and returns `{ vector: [...], dimensions: N }`.

## Database Tables

### `embedding_config` (read-only, check availability)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Always 1 (single-row table) |
| `provider` | TEXT | Embedding provider name |
| `model` | TEXT | Embedding model name |
| `dimensions` | INTEGER | Vector dimensions |

### `embeddings` (for semantic search)

| Column | Type | Description |
|--------|------|-------------|
| `entity_type` | TEXT | Type: `'journal'`, `'node'`, `'issue'`, `'message'`, etc. |
| `entity_id` | INTEGER | ID in the source entity table |
| `vector` | VECTOR | Embedding vector |

### Entity Tables (joined for full content)

- `journal` -- `id`, `note`, `created_at`
- `knowledge_nodes` -- `id`, `name`, `note`, `created_at`
- `issues` -- `id`, `note`, `completed`, `project_id`, `created_at`
- `specifications` -- `id`, `note`, `project_id`, `created_at`
- `conversation_messages` -- `id`, `content`, `role`, `created_at`

## Operations

### Step 1: Check Semantic Search Availability

Before attempting semantic search, check whether the embeddings engine is configured.

```sql
SELECT dimensions FROM embedding_config WHERE id = 1;
```

- If this query **succeeds and returns a row**, semantic search is available. Proceed to Step 2a.
- If this query **fails** (table does not exist) or **returns no rows**, semantic search is unavailable. Skip to Step 2b (text fallback).

### Step 2a: Semantic Search (preferred)

When semantic search is available, use the `embed_query` tool to vectorize the user's search query, then find the nearest matches.

1. Call `embed_query` with the user's search text:

```
embed_query({ text: "the user's search query" })
```

This returns `{ vector: [0.123, ...], dimensions: 1536 }`.

2. If `embed_query` succeeds, search for nearest neighbors using cosine distance:

```sql
SELECT entity_type, entity_id,
       1 - (vector <=> '<vector_string>'::vector) AS similarity
FROM embeddings
WHERE vector IS NOT NULL
ORDER BY vector <=> '<vector_string>'::vector
LIMIT 10;
```

Replace `<vector_string>` with the vector array returned by `embed_query`, formatted as a string (e.g., `'[0.123, 0.456, ...]'`).

3. Join the results back to their source tables to retrieve the full content. Use the `entity_type` to determine which table to join:

For journal entries (`entity_type = 'journal'`):
```sql
SELECT j.id, j.note, j.created_at
FROM journal j WHERE j.id = <entity_id>;
```

For knowledge nodes (`entity_type = 'node'`):
```sql
SELECT kn.id, kn.name, kn.note, kn.created_at
FROM knowledge_nodes kn WHERE kn.id = <entity_id>;
```

For issues (`entity_type = 'issue'`):
```sql
SELECT i.id, i.note, i.completed, p.name AS project_name, i.created_at
FROM issues i
LEFT JOIN projects p ON p.id = i.project_id
WHERE i.id = <entity_id>;
```

For specifications (`entity_type = 'spec'`):
```sql
SELECT s.id, s.note, p.name AS project_name, s.created_at
FROM specifications s
LEFT JOIN projects p ON p.id = s.project_id
WHERE s.id = <entity_id>;
```

4. If `embed_query` fails (returns an error), fall through to Step 2b.

### Step 2b: Text Fallback Search

When semantic search is unavailable or `embed_query` fails, search across all entity tables using case-insensitive text matching.

**Important:** When using this fallback, inform the user: "Using text search (semantic search is not available)."

Search each table independently and combine results:

```sql
-- Journal entries
SELECT 'journal' AS source, id, note AS content, created_at
FROM journal
WHERE note ILIKE '%' || 'search term' || '%'
ORDER BY created_at DESC
LIMIT 5;

-- Knowledge nodes
SELECT 'knowledge' AS source, id, name || ': ' || COALESCE(note, '') AS content, created_at
FROM knowledge_nodes
WHERE name ILIKE '%' || 'search term' || '%'
   OR note ILIKE '%' || 'search term' || '%'
ORDER BY created_at DESC
LIMIT 5;

-- Issues
SELECT 'issue' AS source, id, note AS content, created_at
FROM issues
WHERE note ILIKE '%' || 'search term' || '%'
ORDER BY created_at DESC
LIMIT 5;

-- Specifications
SELECT 'spec' AS source, id, note AS content, created_at
FROM specifications
WHERE note ILIKE '%' || 'search term' || '%'
ORDER BY created_at DESC
LIMIT 5;
```

### Step 3: Source Attribution

Always present results with clear attribution to their source. The user should know where each result came from.

Format examples:
- "From your journal on Jan 15: ..."
- "From your knowledge graph -- Alice: works at Acme Corp"
- "From project X, issue #3: ..."
- "From a specification in project Y: ..."

Include dates and context to help the user identify the result they are looking for.

## Restrictions and Notes

- Always try semantic search first when available. It produces better results for natural language queries.
- If semantic search is unavailable, always use the text fallback. Never tell the user that search is impossible.
- Always attribute results to their source table and include timestamps.
- If no results are found across any table, say so clearly and suggest alternative search terms or phrasing.
- Do not modify any data during recall operations. This skill is read-only -- it only searches.
- When presenting multiple results, rank them by relevance (similarity score for semantic, or recency for text fallback).
- If the user's query seems to target a specific data type (e.g., "my journal entries about X"), you may search only the relevant table rather than all tables.
- Keep the result presentation concise. Summarize long entries rather than dumping full content, unless the user asks for detail.
