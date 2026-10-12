# Files

A company document manager. People upload a file; Claude reads it, writes a short summary, pulls out key facts and files it in the right folder. Anyone with access finds files by asking in plain English or Arabic.

Built in four phases (see `prompt-file-manager.md`). **Phases 1 and 2 are in place, without AI:** Microsoft sign-in, companies, roles and users, and a complete manual filing system. Uploading, filing, browsing, versions and review all work by hand. The code that reads files with Claude and files them automatically (`src/lib/analysis.ts`, `ai.ts`, `filing.ts`) is written and tested but not wired in yet. Search comes in phase 3; operations and the full guide in phase 4.

## How filing works

1. **Upload** from any page: drag files onto it, or press Upload. Files go straight from the browser to the storage bucket; nothing passes through the app server.
2. **Choose the folder first**, by opening it before uploading. A file uploaded with no folder open waits in **Review** until someone files it.
3. **Open a file** to preview PDFs and images, edit its title, summary, type, date and tags, move it, rename it, add a new version, or delete it. Deleted files stay in **Deleted** for 30 days.
4. **Identical files** are detected by content; you can open the existing one or upload anyway.
5. **Admins** manage folders in Settings: create, rename, describe, nest, restrict, grant access, deactivate.

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 with shadcn/ui, Auth.js v5 with Microsoft Entra ID, Prisma 7 on Postgres (Neon), Cloudflare R2 for file bytes, Claude for reading and filing.

## Roles

| Role | Can |
|---|---|
| Owner | Everything, in every company (set from the command line) |
| Admin | Everything in their company, including folders and users |
| Editor | Upload; rename, move and delete their own uploads; accept filing suggestions |
| Viewer | Browse, search and download |

Restricted folders (HR and Finance / Bank by default) are visible only to admins, owners and people granted access. A file waiting in Review is visible only to whoever uploaded it, and to admins.

## Local development

```bash
pnpm install
cp .env.example .env              # fill in at least DATABASE_URL, AUTH_SECRET and the Entra values
pnpm exec prisma dev --name files # optional: a local Postgres, prints its connection string
pnpm db:deploy
pnpm org add api-pharma --name "API Pharma" --domain api-pharma.net
pnpm user add you@api-pharma.net --owner
pnpm dev
```

`GET /api/health` reports what is configured and reachable.

## Commands

| Command | What it does |
|---|---|
| `pnpm org add <slug> --name <name> --domain <domain>` | Create a company and its default folders |
| `pnpm user add <email> --org <slug> --role admin\|editor\|viewer` | Add someone to a company |
| `pnpm user add <email> --owner` | Make someone an owner |
| `pnpm user list` | Everyone, with their companies |
| `pnpm user remove <email> [--org <slug>]` | Remove from one company, or deactivate everywhere |
| `pnpm folders seed [--org <slug>]` | Create any missing default folders |
| `pnpm test` | Unit tests; database tests also run when `TEST_DATABASE_URL` is set |
| `pnpm typecheck`, `pnpm build` | Type-check; production build |
| `pnpm db:generate`, `db:migrate`, `db:deploy`, `db:studio` | Prisma |

Database tests create a throwaway schema per file in the database at `TEST_DATABASE_URL`, so point it at a disposable database, never production.
