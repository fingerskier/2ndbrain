# Skill: journal

## Description

Create and search personal journal entries. Use this skill when the user wants to capture a thought, reflect on something, make a note to self, or recall past journal entries. Journal entries are free-form text stored with timestamps.

## When to Activate

Activate this skill when any of the following conditions are met:

- The user's message begins with `/journal`
- The user expresses intent to record a thought or note (e.g., "note to self", "I want to remember", "remind me that", "journal this", "write down that")
- The user asks to recall or search past journal entries (e.g., "what did I write about X", "my notes from last week", "find my journal entry about")
- The user is reflecting or wants to preserve a thought for later

## Available Tools

- `mcp__pg__query` -- Execute SQL queries against the PostgreSQL database.

No other tools are permitted for this skill.

## Database Tables

### `journal`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation (defaults to NOW()) |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update (defaults to NOW()) |
| `note` | TEXT NOT NULL | The journal entry content |

### `embeddings` (for post-create embedding queue only)

| Column | Type | Description |
|--------|------|-------------|
| `entity_type` | TEXT NOT NULL | Type of entity (use `'journal'` for journal entries) |
| `entity_id` | INTEGER NOT NULL | The `id` of the journal entry |
| `vector` | VECTOR | Embedding vector (managed by the embeddings engine) |

## Operations

### Create a Journal Entry

When the user wants to record something, insert a new row into the `journal` table.

```sql
INSERT INTO journal (note)
VALUES ('The user''s note content goes here')
RETURNING id, created_at;
```

After creating the entry, always confirm to the user what was saved, including the timestamp.

### Search Journal Entries by Text

When the user asks to find or recall entries by keyword or topic, use case-insensitive pattern matching.

```sql
SELECT id, note, created_at
FROM journal
WHERE note ILIKE '%' || 'search term' || '%'
ORDER BY created_at DESC
LIMIT 10;
```

### Date-Filtered Recall

When the user asks about entries from a specific time period (e.g., "last week", "in December", "yesterday"), filter by date range.

```sql
SELECT id, note, created_at
FROM journal
WHERE created_at >= '2026-01-24T00:00:00Z'
  AND created_at < '2026-01-31T00:00:00Z'
ORDER BY created_at DESC;
```

Interpret relative time references (e.g., "last week", "yesterday", "past month") based on the current date provided in the system prompt.

### List Recent Entries

When the user asks to see recent journal entries without a specific search term.

```sql
SELECT id, note, created_at
FROM journal
ORDER BY created_at DESC
LIMIT 10;
```

### Post-Create: Queue for Embedding

After successfully creating a journal entry, attempt to queue it for embedding generation. This enables future semantic search over journal content.

```sql
INSERT INTO embeddings (entity_type, entity_id)
VALUES ('journal', <new_entry_id>)
ON CONFLICT DO NOTHING;
```

**Important:** The `embeddings` table only exists when the embeddings engine is enabled. If this query fails because the table does not exist, silently ignore the error and proceed normally. The journal entry is already saved -- embedding is optional and supplementary. Do not report the embedding queue failure to the user.

## Restrictions and Notes

- Always use `mcp__pg__query` for database operations. Do not use any other tool.
- Never delete or modify existing journal entries unless the user explicitly asks to edit or remove a specific entry.
- When presenting journal entries to the user, include the date/time of each entry for context.
- If the user's message is ambiguous about whether they want to create an entry or search for one, ask for clarification.
- Keep confirmations concise: after saving, say something like "Noted." or "Saved to your journal." along with the timestamp -- do not repeat the entire entry back unless it is very short.
- For search results, present entries in reverse chronological order with dates.
- If no results are found for a search, say so clearly and suggest broadening the search terms.
