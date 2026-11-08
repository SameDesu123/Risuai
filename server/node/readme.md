# Risuai Node Server

> Warning: Node server may be deprecated in future versions, replaced with [Hono](https://hono.dev/) based server which could run in multiple environments including nodejs, deno, and serverless platforms such as Cloudflare Workers, Vercel Edge Functions, etc.

This is the Node.js server for Risuai, for self-hosting purposes, who want to run Risuai on their own server remotely, without using official server for privacy or other reasons.
## How saves are stored

The browser keeps the database in memory and, on each save, sends the server only the save blocks that changed (`POST /api/db/save`). The server keeps the blocks of the last save in memory, gzips the large ones, assembles `database/database.bin`, writes a backup next to it and keeps the 20 newest backups. The files are stored in the `save` folder with the same names as before, so older versions of Risuai can still read them.

After a server restart, or when `database.bin` is written some other way, the browser sends every block once on its next save.
