# Skill: knowledge

## Description

Manage a personal knowledge graph with nodes and edges. Nodes represent concepts, people, places, ideas, or anything worth tracking. Edges represent named, directed relationships between nodes (e.g., "works at", "related to", "depends on"). Use this skill to build, query, and traverse the user's personal knowledge graph.

## When to Activate

Activate this skill when any of the following conditions are met:

- The user's message begins with `/knowledge`
- The user mentions entities and wants them tracked (e.g., "remember that Alice works at Acme Corp", "Bob is my dentist")
- The user asks about relationships between things (e.g., "how is X related to Y", "what do I know about X", "who works at Y")
- The user wants to create, update, or explore connections between concepts
- The user asks to list or browse known entities

## Available Tools

- `mcp__pg__query` -- Execute SQL queries against the PostgreSQL database.

No other tools are permitted for this skill.

## Database Tables

### `knowledge_nodes`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `name` | TEXT NOT NULL | Name of the entity (person, concept, place, etc.) |
| `note` | TEXT | Optional descriptive note about the entity |

### `knowledge_edges`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `source_id` | INTEGER NOT NULL | FK to `knowledge_nodes.id` (the "from" node) |
| `target_id` | INTEGER NOT NULL | FK to `knowledge_nodes.id` (the "to" node) |
| `name` | TEXT NOT NULL | Relationship label (e.g., "works at", "is friend of") |

There is a unique constraint on `(source_id, target_id, name)` to prevent duplicate edges.

### `embeddings` (for post-create embedding queue only)

| Column | Type | Description |
|--------|------|-------------|
| `entity_type` | TEXT NOT NULL | Type of entity (use `'node'` for knowledge nodes) |
| `entity_id` | INTEGER NOT NULL | The `id` of the knowledge node |

## Operations

### Create a Node

When the user mentions a new concept, person, place, or idea to track.

```sql
INSERT INTO knowledge_nodes (name, note)
VALUES ('Alice', 'Friend from university, works in data science')
RETURNING id, name;
```

Before creating a node, check if one with the same name already exists to avoid duplicates:

```sql
SELECT id, name, note FROM knowledge_nodes WHERE name ILIKE 'Alice';
```

If a match exists, ask the user whether to update the existing node or create a new one.

### Create an Edge

When the user describes a relationship between two entities.

```sql
INSERT INTO knowledge_edges (source_id, target_id, name)
VALUES (1, 2, 'works at')
ON CONFLICT (source_id, target_id, name) DO NOTHING;
```

Both the source and target nodes must exist before creating an edge. If either does not exist, create the missing node(s) first (with user confirmation if the intent is ambiguous).

### Query a Node by Name

When the user asks "what do I know about X" or mentions an entity by name.

```sql
SELECT id, name, note, created_at
FROM knowledge_nodes
WHERE name ILIKE '%' || 'search term' || '%';
```

### Traverse Edges from a Node

When the user asks about relationships or connections (e.g., "how is X connected", "what is related to X").

Outgoing relationships (what does X relate to):

```sql
SELECT kn.name AS target, ke.name AS relationship
FROM knowledge_edges ke
JOIN knowledge_nodes kn ON kn.id = ke.target_id
WHERE ke.source_id = <node_id>;
```

Incoming relationships (what relates to X):

```sql
SELECT kn.name AS source, ke.name AS relationship
FROM knowledge_edges ke
JOIN knowledge_nodes kn ON kn.id = ke.source_id
WHERE ke.target_id = <node_id>;
```

For a complete picture, run both queries and present all connections.

### Full-Text Search

Search across both the `name` and `note` fields of knowledge nodes.

```sql
SELECT id, name, note, created_at
FROM knowledge_nodes
WHERE name ILIKE '%' || 'search term' || '%'
   OR note ILIKE '%' || 'search term' || '%'
ORDER BY updated_at DESC
LIMIT 10;
```

### Update a Node

When the user wants to add or change information about an existing entity.

```sql
UPDATE knowledge_nodes
SET note = 'Updated information here',
    updated_at = NOW()
WHERE id = <node_id>;
```

### Post-Create: Queue for Embedding

After successfully creating a knowledge node, attempt to queue it for embedding generation.

```sql
INSERT INTO embeddings (entity_type, entity_id)
VALUES ('node', <new_node_id>)
ON CONFLICT DO NOTHING;
```

**Important:** The `embeddings` table only exists when the embeddings engine is enabled. If this query fails because the table does not exist, silently ignore the error and proceed normally. The knowledge node is already saved -- embedding is optional. Do not report the embedding queue failure to the user.

## Restrictions and Notes

- Always use `mcp__pg__query` for database operations. Do not use any other tool.
- Edges are directed: "Alice works at Acme" means Alice is the source and Acme is the target. Choose direction to reflect the natural reading of the relationship.
- Before creating nodes, always check for existing nodes with similar names to prevent duplicates.
- When presenting graph data to the user, format it clearly -- list relationships in a readable way rather than dumping raw SQL results.
- If the user describes multiple entities and relationships in one message, process them all (create nodes first, then edges).
- Never delete nodes or edges unless the user explicitly requests it. Deleting a node cascades to all its edges.
- When searching, if no exact match is found, try broader partial matches and present the closest results.
