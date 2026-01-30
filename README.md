# 2ndbrain

An always-on Node.js npx service that bridges Telegram messges to Claude with
* persistent conversation history (logs)
* receive text messages w/ attachments
* slash commands
* send text message responses w/ "Typing" indicator
* whitelist users that it will interact with (multi-layered)
* can run local commands, access local postgres (mcp) (whitelisted)


## Setup

* Start the `npx ...` runner on boot
* Ensure that local postgres & MCP are ready
* Ensure that claude-cli is ready


## Vision

* You setup `2ndbrain` on a computer on your LAN (e.g. rapsberry pi 5)
* You, and only you, can access with it by chatting over Telegram
* **2ndbrain** uses Claude + local MCP tools to do stuff and respond to you
* Web server interface
  * Setup wizard
  * Adjust settings & environment variables
  * View activity logs
* GPIO interaction
* Auto-compact history
* Errors get pushed to the user
* Graceful shutdown/restart
* Rate-limiting of Claude and Telegram
* Store attachments in `~/data`
* Vector embeddings of db records


## Slashes

Enter slash commands in Telegram messages to perform tasks

`/status`
`/health`
`/restart`
`/reboot`
`/stop`
 

## Data Schema

* Projects(id, created, updated, name)
  * Specifications(id, created, updated, project_id, note)
  * Issues(id, created, updated, note, completed)
* _knowledge_graph
  * Nodes(id, created, updated, name, note)
  * Edges(id, created, updated, node1_id, node2_id, name)
* Journal(id, created, updated, note)
* History(id, created, updated, user_id, message_id, content)
* Logs(id, timestamp, content, level)
* Embeddings(id, created, updated, entity_type, vector)


## Claude Stuff

Skills <TBD>
Hooks <TBD>


## Caveats

* Run Claude w/ top model, thinking, ?accept edits?
