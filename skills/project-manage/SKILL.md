# Skill: project-manage

## Description

Manage projects, specifications, and issues. Use this skill to create projects, add tasks and issues, write specifications, track progress, mark items complete, and get project status summaries. Supports hierarchical sub-tasks and nested specifications.

## When to Activate

Activate this skill when any of the following conditions are met:

- The user's message begins with `/project`
- The user mentions tasks, projects, or work items (e.g., "I need to do X", "add a task for Y", "create a project for Z")
- The user asks about project status (e.g., "what's the status of project Z", "what tasks are open", "what's left to do")
- The user wants to track issues, bugs, or blockers
- The user wants to document a specification, requirement, or architecture decision
- The user marks something as done or complete

## Available Tools

- `mcp__pg__query` -- Execute SQL queries against the PostgreSQL database.

No other tools are permitted for this skill.

## Database Tables

### `projects`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `name` | TEXT NOT NULL | Name of the project |

### `issues`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `project_id` | INTEGER | FK to `projects.id` (nullable -- issues can exist without a project) |
| `parent_id` | INTEGER | FK to `issues.id` (nullable -- for sub-task hierarchy) |
| `note` | TEXT NOT NULL | Description of the issue or task |
| `completed` | BOOLEAN NOT NULL DEFAULT FALSE | Whether the issue is resolved |

### `specifications`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `project_id` | INTEGER NOT NULL | FK to `projects.id` |
| `parent_id` | INTEGER | FK to `specifications.id` (nullable -- for nested specs) |
| `note` | TEXT NOT NULL | Specification content |

## Operations

### List All Projects (No Arguments)

When the user sends `/project` with no additional text, list all projects with status:

```sql
SELECT
  p.id,
  p.name,
  p.created_at,
  COUNT(i.id) FILTER (WHERE NOT i.completed) AS open_issues,
  COUNT(i.id) FILTER (WHERE i.completed) AS closed_issues,
  COUNT(DISTINCT s.id) AS spec_count
FROM projects p
LEFT JOIN issues i ON i.project_id = p.id
LEFT JOIN specifications s ON s.project_id = p.id
GROUP BY p.id, p.name, p.created_at
ORDER BY p.updated_at DESC;
```

Present as a concise listing. If no projects exist, respond: "No projects found. Send `/project <description>` to create one."

### Parse and Scaffold from Description

When the user sends `/project` followed by a natural language description, parse it and create the appropriate database records:

1. **Extract the project name** from the description. Use the most prominent noun phrase or explicit project name.

2. **Check for existing project** (case-insensitive):

```sql
SELECT id, name FROM projects WHERE name ILIKE '%project name%';
```

   - If a match exists, use the existing project ID (do not create a duplicate).
   - If multiple matches, list them and ask the user to clarify.
   - If no match, create a new project.

3. **Extract specifications** -- any requirements, constraints, architecture decisions, API contracts, or design notes from the description. Insert each:

```sql
INSERT INTO specifications (project_id, note)
VALUES (<project_id>, 'extracted specification')
RETURNING id, note;
```

   Use `parent_id` when specifications have a natural parent-child hierarchy.

4. **Extract issues/tasks** -- any action items, features to build, bugs to fix, or work items. Insert each:

```sql
INSERT INTO issues (project_id, note)
VALUES (<project_id>, 'extracted task or issue')
RETURNING id, note;
```

   Use `parent_id` when tasks have a natural hierarchy.

5. **Upsert behavior:** Before inserting a specification or issue, check if one with very similar text already exists for this project:

```sql
SELECT id, note FROM specifications WHERE project_id = <project_id> AND note ILIKE '%key phrase%';
SELECT id, note FROM issues WHERE project_id = <project_id> AND note ILIKE '%key phrase%';
```

   If a match exists, skip it (note as "already exists" in the summary). Do not delete existing records.

6. **Respond with a summary** of everything created or found:

```
Project: <name> (id: <id>) [created | existing]

Specifications:
- <spec note> (id: <id>)
- <spec note> (id: <id>) [already exists]

Issues:
- <issue note> (id: <id>)
- <issue note> (id: <id>) [already exists]
```

### Create a Project

When the user wants to start tracking a new project.

```sql
INSERT INTO projects (name)
VALUES ('My New Project')
RETURNING id, name, created_at;
```

Before creating, check if a project with the same name already exists:

```sql
SELECT id, name FROM projects WHERE name ILIKE 'My New Project';
```

### Create an Issue or Task

When the user wants to add a task, bug, blocker, or to-do item.

```sql
INSERT INTO issues (project_id, note)
VALUES (<project_id>, 'Description of the task')
RETURNING id, note, created_at;
```

If the user does not specify a project, either ask which project it belongs to, or create the issue without a project (`project_id = NULL`).

### Create a Sub-Task

Issues support hierarchical nesting via `parent_id`. When the user wants to break a task into smaller pieces.

```sql
INSERT INTO issues (project_id, parent_id, note)
VALUES (<project_id>, <parent_issue_id>, 'Sub-task description')
RETURNING id, note, created_at;
```

### Create a Specification

When the user wants to document a requirement, architecture decision, or design note for a project.

```sql
INSERT INTO specifications (project_id, note)
VALUES (<project_id>, 'Specification content here')
RETURNING id, note, created_at;
```

Specifications also support nesting via `parent_id` for hierarchical documentation:

```sql
INSERT INTO specifications (project_id, parent_id, note)
VALUES (<project_id>, <parent_spec_id>, 'Child specification detail')
RETURNING id, note, created_at;
```

### Mark an Issue as Complete

When the user says something is done, finished, or complete.

```sql
UPDATE issues
SET completed = TRUE, updated_at = NOW()
WHERE id = <issue_id>;
```

To reopen an issue:

```sql
UPDATE issues
SET completed = FALSE, updated_at = NOW()
WHERE id = <issue_id>;
```

### Project Status Summary

When the user asks for an overview of a project or all projects. Show counts of open and closed issues.

For a single project:

```sql
SELECT
  p.name AS project,
  COUNT(i.id) FILTER (WHERE NOT i.completed) AS open_issues,
  COUNT(i.id) FILTER (WHERE i.completed) AS closed_issues,
  COUNT(i.id) AS total_issues
FROM projects p
LEFT JOIN issues i ON i.project_id = p.id
WHERE p.id = <project_id>
GROUP BY p.id, p.name;
```

For all projects:

```sql
SELECT
  p.name AS project,
  COUNT(i.id) FILTER (WHERE NOT i.completed) AS open_issues,
  COUNT(i.id) FILTER (WHERE i.completed) AS closed_issues,
  COUNT(i.id) AS total_issues
FROM projects p
LEFT JOIN issues i ON i.project_id = p.id
GROUP BY p.id, p.name
ORDER BY p.name;
```

### List Open Issues for a Project

```sql
SELECT id, note, created_at, parent_id
FROM issues
WHERE project_id = <project_id>
  AND completed = FALSE
ORDER BY created_at ASC;
```

### View Sub-Task Hierarchy

To display an issue with its sub-tasks:

```sql
SELECT id, note, completed, parent_id, created_at
FROM issues
WHERE parent_id = <parent_issue_id>
ORDER BY created_at ASC;
```

### List Specifications for a Project

```sql
SELECT id, note, parent_id, created_at
FROM specifications
WHERE project_id = <project_id>
ORDER BY created_at ASC;
```

### Search Across Issues

```sql
SELECT i.id, i.note, i.completed, p.name AS project
FROM issues i
LEFT JOIN projects p ON p.id = i.project_id
WHERE i.note ILIKE '%' || 'search term' || '%'
ORDER BY i.created_at DESC
LIMIT 10;
```

## Restrictions and Notes

- Always use `mcp__pg__query` for database operations. Do not use any other tool.
- When the user mentions a project by name, look it up first. If multiple projects match, list them and ask the user to clarify.
- When marking items complete, confirm which specific issue is being completed. If the user says "mark it done" ambiguously, ask which task they mean.
- Present project status in a clear, concise format. Use counts and lists, not raw SQL output.
- Issues can exist without a project (`project_id = NULL`). These are standalone tasks.
- When showing sub-tasks, indicate the hierarchy clearly (e.g., indent or label parent/child relationships).
- Never delete projects, issues, or specifications unless the user explicitly asks for deletion.
- When a project has many issues, summarize by status (open vs. closed) rather than listing every single one, unless the user asks for a full list.
