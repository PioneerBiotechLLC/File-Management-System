# Files

A company document manager. People upload a file; Claude reads it, writes a short summary, pulls out key facts and files it in the right folder. Anyone with access finds files by asking in plain English or Arabic.

Built in phases (see `prompt-file-manager.md`). **In place:** Microsoft sign-in, companies, roles and users, the filing system, an activity log, and AI filing: Claude reads each upload and drafts the summary, the uploader confirms it, Claude suggests the folder, the uploader confirms that too. Nothing is filed without a person confirming both. AI spend is capped per person and per company, with a Usage dashboard for admins. Search works over the confirmed summaries: by keyword, or with AI search for questions. Operations and the full guide come next.

## How filing works

1. **Upload** from any page: drag a file onto it, or press Upload. Files go straight from the browser to the storage bucket; nothing passes through the app server. Everyone uploads one file at a time; admins may upload several.
2. **The AI reads it** (5–30 seconds, under a minute) and drafts the summary: what the document is, who it is from and to, its date, the prices, the materials or products, every reference number, and the line items (description, quantity, unit price, total) of quotations, orders, invoices, delivery notes and price lists. The file itself is sent to Claude for this one read; nothing from its contents is stored except the summary.
3. **Check the summary** in **Review**: fix anything wrong and confirm. Uploaded by mistake? The bin icon on the card removes it (to Deleted, restorable for 30 days); a file still waiting in the upload panel can be cancelled there. When the AI could not read the file (too large, an unsupported type, handwritten or unclear, a spend cap reached, or a failure), you write the summary yourself. Every filed file has a confirmed summary.
4. **Confirm where it goes.** Documents exchanged with a customer or supplier are filed as `<year> / Customers|Suppliers / <company> / <kind>` (Quotations, Purchase Orders, Delivery Notes, Invoices, Certificates of Analysis, Contracts, Price Lists, Payments & Receipts, Shipping & Customs, Correspondence). The year is the document's own date. The AI proposes the side, the company (matched to existing ones whatever the spelling: case, spaces, punctuation and legal forms are ignored, so ARABLAB and Arab Lab L.L.C. are one; or marked new) and the kind; the folders are created the first time they are needed. Technical documents about a material (certificates of analysis, specifications and data sheets, safety data sheets, test reports) are filed as `Technical / <manufacturer> / <material> / <kind>`: the manufacturer is the maker named on the document (always a supplier), and materials are matched whatever the spelling, like companies. Everything else goes in the company's own folders: Quality & Regulatory, HR, Legal, Marketing, Bank and General. Change the proposal if needed and save; only then is the file filed, and the log records who confirmed what and any customer or supplier added.
5. **Open a file** to preview PDFs and images, edit its title, summary, type, date and tags, move it, rename it, add a new version, or delete it. Deleted files stay in **Deleted** for 30 days.
6. **Identical files** are detected by content; you can open the existing one or upload anyway.
7. **Admins** manage folders in Settings: create, rename, describe, nest, restrict, grant access, deactivate. **Owners** also set the company's logo and colour there, and can remove every file to start over (typing the company's slug to confirm; the company's own folders, people, log and AI spend stay).
8. **Log** (admins): every sign-in, upload, AI read, summary confirmation, search, download, view, move, rename, delete and setting change, with the email of who did it.
9. **Usage** (admins): what the AI cost today and this month, per person and for the company, against the limits; limits can be changed there.

## The facts CSV beside each file

Every filed file also has a small CSV beside its bytes in the bucket (`<company id>/<file id>/facts.csv`): customer or supplier, document type and date, folder, amounts, reference numbers, tags, who uploaded and confirmed it, and one row per line item (description, quantity, unit price, total, currency), with the file's columns repeated on each row so many CSVs stack into one sheet. It is written when the summary is confirmed and rewritten whenever the summary, details, name or folder change; it is purged with the file. The app never shows it: `/c/<slug>/files/<id>/facts` downloads it for anyone who may download the file, and `pnpm facts rebuild [--org <slug>]` writes it for every existing file (run once after deploying this).

## Bulk upload

Admins have a **Bulk upload** tab: choose a folder (subfolders included) or a set of files, press Upload and file, and keep the tab open. Zips are opened in the browser (zips inside zips too, three levels deep) and each file inside is uploaded and filed on its own; the zip itself is not stored. Each file is uploaded, read by the AI and filed at once when the AI read it and was at least 60% sure; the summary stands as the AI wrote it and the log says so ("Filed by bulk upload"). Anything under 60%, and anything with no place in the tree, goes to **General** with an **Unsure** badge, shown in file lists, search and on the file; moving the file anywhere clears it. A file the AI cannot read at all (damaged, empty, a kind it cannot open) is deleted, and can be restored from **Deleted** for 30 days. A file over `FILES_AI_MAX_MB` (22 MB; the AI does not read larger ones) goes to General under its own name, marked unsure, for someone to move. Only reads that failed for a reason that may pass (an API error, say) wait in Review, with "Try again with AI"; duplicates are skipped. Email attachments follow the same rules. Review has a **File everything automatically** button for admins that applies them to what is already there: read files are filed, unreadable ones deleted, failed reads tried once more, and files someone has started confirming are left alone. Uploads may be up to `FILES_MAX_MB` (1900 MB by default). New customers and suppliers are created as needed and listed at the end. The AI reads one file at a time per person (10–20 seconds each), so a hundred files take about half an hour. The page is the report; it can be downloaded as CSV.

Tick **Read in a batch** to have the files read through Anthropic's Message Batches API instead: half the price, with results within 24 hours (usually within the hour). The files are uploaded as usual, then sent in batches of up to 100 files or 40 MB; each request is the same one a live read sends. When a batch finishes, each file is stored and filed exactly as a live read would be (60%, General marked unsure, unreadable deleted), and the cost is logged at the batch price. The bulk page shows what waits to be sent and what is with the AI, and checks for results every two minutes while it is open. Nothing depends on the page staying open: `/api/cron/batches` (called every 15 minutes by `.github/workflows/cron.yml`, with the repository secrets `APP_URL` and `CRON_SECRET`; Vercel's own cron on this project runs daily) sends what waits and takes in what finished, and the Review page does the same whenever an admin opens it, with a **Send and check now** button and the counts. Every run is bounded by a deadline and resumable, so a big batch is taken in over a few runs rather than lost. Files in a batch show as "Waiting for batch reading" in Review. A file whose batch read failed comes back to Review with "Try again with AI".


## Re-filing

Admins have a **Re-file** tab for files that are already in the system. Choose a group (Technical documents, Customer and supplier documents, Company folders, or the files left in Review), tick **Preview only** to see what would move, then run it again without the tick. The AI reads each stored file again with the current filing rules and moves it only when it is at least 60% sure it belongs elsewhere, the same as for files in Review. Nothing is uploaded again; every move is in the Log, and the page can be downloaded as a CSV report. Each file costs one AI read, the same as a first upload. A customer's own specification for a material is filed under that customer's **Specifications** folder, not under Technical.
## Email attachments from the Email Tracker

The Email Tracker (the sibling app) sends every attachment of every email it stores, up to 25 MB, in through `POST /api/integrations/email-attachments` (start: metadata, answered with a presigned upload URL or the identical file already here), a `PUT` of the bytes straight to the bucket, and `POST /api/integrations/email-attachments/<id>/confirm`. The bearer token is `FILES_INTEGRATION_API_KEY` (at least 32 characters; the same value is the tracker's `FILES_API_KEY`); without it the endpoints refuse everything, and the middleware leaves them open only because of that check. The contract is written up in the tracker repository, `docs/files-integration.md`; the tracker lists, filters (no signature pictures, invites or contact cards) and sends attachments right after each mailbox sync, for received and sent mail.

Each company gets a system user, **email-tracker@<domain>**: deactivated (it can never sign in; Settings → Users shows it as such), an editor, so its AI reads count against the usual per-person and company spend caps (raise its caps in Usage if the mail volume needs it). The file is uploaded as that user with *Source: email attachment* and the email's Message-ID as its source reference; the Log records the email's subject, sender, recipients, mailbox and a link back to the tracker (`file.email_attachment`). After confirm the AI reads the file in the background and files it exactly like a bulk upload: at least 60 % sure → filed at once, the summary standing as the AI wrote it; less sure, or no place in the tree → **General**, marked unsure; a file the AI cannot read is deleted (restorable for 30 days); only a read that failed for a passing reason waits in **Review**. The system user's reads run one at a time, so the work after each confirm also reads the attachments confirmed while it was busy (up to about four and a half minutes per confirm); the daily sweep reads whatever is still waiting. A file whose bytes are already in the company (the same attachment sent twice, or one a colleague was Cc'd on) is not stored again; the tracker links the email to the existing file.

## Search

Search looks only at what people confirmed: the name, title, summary, type, date, parties, reference numbers, amounts, products and tags. Nothing from a file's contents is indexed. Access is applied in the database query, so a file in a restricted folder never appears for someone without access, and the AI never sees it either.

- **Browse** (the dropdowns under the search box on the Files page): year, Customers or Suppliers, company and document kind. Set any of them and every matching customer or supplier document is listed at once, with no AI. Each list offers only what still has files given the other choices, so picking 2025 hides every company and kind with nothing in 2025. The choices are in the address, so a filtered list can be bookmarked or sent.

The search box sits at the top of the Files page (inside a folder it searches that folder) and of `/c/<slug>/search`, with two buttons. Enter is Search, Ctrl/⌘+Enter is AI search.

- **Search** uses no AI. Letters and digits are matched separately, so "PO-4512", "PO#4512" and "4512" all find the same order; Arabic is folded so "الإنسولين" and "انسولين" meet. It tries every word first, then the identifying numbers alone, then any word. Filters: folder (with subfolders), type, date range.
- **AI search** is for questions: "the insulin quotation we sent Gulf Pharmacy last spring, around 40k AED". The light model turns the question into searches with amount and date ranges, reads the likeliest summaries in full and answers in a short paragraph with the details (dates, amounts, references, the company), the files as cards and why each matches. It keeps the filters chosen on the search page and can cite only files the search returned. At most 6 lookups per question, under $0.03 a question; `FILES_AI_SEARCHES_PER_USER_PER_DAY` questions per person per day (default 50), plus the spend caps below. A reload never repeats an AI search.
- Every search is logged; admins see them in Log under Searches.
- `pnpm index rebuild [--org <slug>]` rebuilds the search entries, needed once after the first deploy of search.

## AI costs and limits

The AI reads with `ANTHROPIC_MODEL` (Claude Sonnet 5.5 by default) and chooses folders with `ANTHROPIC_MODEL_LIGHT` (Claude Haiku 5.5). A typical one- or two-page document costs about $0.01–0.03 to read; a long PDF up to about $0.40. The folder choice after an edited summary costs well under a cent. Every call is recorded with its tokens and cost.

Spend is capped in USD per person per day and month, and per company per day and month. Admins and owners have no cap, and what they spend is not counted against the company's caps (a big upload by an admin must not switch the AI off for everyone); it is still recorded and shown in Usage. The defaults come from `AI_USER_DAILY_USD`, `AI_USER_MONTHLY_USD`, `AI_DAILY_USD` and `AI_MONTHLY_USD`; admins override them in Usage, but never above `AI_DAILY_USD_MAX` and `AI_MONTHLY_USD_MAX`, which only the environment sets. Each call reserves an estimate against the caps the moment it starts, and each person runs one AI call at a time, so parallel requests cannot slip past a cap; a cap can still be overshot by at most one call. A model that is not in the price table (`src/lib/ai-prices.ts`) is refused rather than charged at $0, and `AI_MAX_CALLS_PER_DAY=0` switches the AI off. When a cap is reached the AI stops and people write summaries by hand until it resets, so uploading never stops. Set a spend limit in the Anthropic console as well.

Safeguards against text planted in documents: the model is told that documents are data, not instructions; it can only choose among the folders the uploader may write to, which the code enforces again; the output must match a strict schema; and a person confirms the summary and the folder before anything is filed.

## Look

The app wears API Pharma's identity: crimson `#be272c` on warm paper, ink text, Source Sans 3 for text and Merriweather for page titles (both self-hosted by Next, so the font policy stays `'self'`), and the flame mark as the icon and on the sign-in page. The colours are tokens at the top of `src/app/globals.css`. Each company's own logo and colour in the header come from `pnpm org brand`; the logo file for API Pharma is `public/brand/api-pharma-mark.png`.

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 with shadcn/ui, Auth.js v5 with Microsoft Entra ID, Prisma 7 on Postgres (Neon), Cloudflare R2 for file bytes, Claude for reading and filing.

## Roles

| Role | Can |
|---|---|
| Owner | Everything, in every company (set from the command line) |
| Admin | Everything in their company, including folders and users |
| Editor | Upload; rename, move and delete their own uploads; accept filing suggestions |
| Viewer | Browse, search and download |

Everyone's AI reading is limited by the spend caps above; viewers never upload, so they spend nothing.

Restricted folders (HR and Finance / Bank by default) are visible only to admins, owners and people granted access. A file waiting in Review is visible only to whoever uploaded it, and to admins.

## Local development

```bash
pnpm install
cp .env.example .env              # fill in at least DATABASE_URL, AUTH_SECRET, the Entra values and AUTH_ALLOWED_TENANT_IDS
pnpm exec prisma dev --name files # optional: a local Postgres, prints its connection string
pnpm db:deploy
pnpm org add api-pharma --name "API Pharma" --domain api-pharma.net
pnpm user add you@api-pharma.net --owner
pnpm dev
```

`GET /api/health` answers `{ ok }` to anyone and the details (what is missing, what is reachable) to signed-in users.

## Sign-in and security

Only Microsoft accounts from the tenants in `AUTH_ALLOWED_TENANT_IDS` (or the tenant named in `AUTH_MICROSOFT_ENTRA_ID_ISSUER`) can sign in; Microsoft does not verify the email claim across tenants, so other tenants are turned away before the email is looked at. The first Microsoft account that signs in as a listed user is remembered (tenant and object id) and is afterwards the only one that can; someone with the same email on another account is refused and logged. To move a user to a new account, clear `entraTid`/`entraOid` on their row.

Uploads go to a staging key in the bucket and are copied to their final key when confirmed, so the upload URL cannot change a file after it was checked. A read-only grant on a restricted folder is read-only: files there can only be moved, renamed, replaced or deleted by people who can write there. `/api/cron/sweep` (Vercel Cron, daily, `Authorization: Bearer $CRON_SECRET`) removes abandoned uploads and purges files 30 days after deletion. Every response carries a Content-Security-Policy and the usual security headers.

## Commands

| Command | What it does |
|---|---|
| `pnpm org add <slug> --name <name> --domain <domain>` | Create a company and its default folders |
| `pnpm org reset-files <slug> --confirm <slug>` | The same reset as the owner's button in Settings, for a database and bucket the shell can reach |
| `pnpm org brand <slug> --logo <url> --color <hex>` | The company's logo and colour in the header (e.g. `--logo /brand/api-pharma-mark.png --color "#be272c"`) |
| `pnpm user add <email> --org <slug> --role admin\|editor\|viewer` | Add someone to a company |
| `pnpm user add <email> --owner` | Make someone an owner |
| `pnpm user list` | Everyone, with their companies |
| `pnpm user remove <email> [--org <slug>]` | Remove from one company, or deactivate everywhere |
| `pnpm folders seed [--org <slug>]` | Create any missing default folders |
| `pnpm folders restructure --org <slug>` | One-time move to year folders: Bank to the top, old Sales/Purchasing/Logistics/Finance closed (files stay readable) |
| `pnpm index rebuild [--org <slug>]` | Rebuild the search index |
| `pnpm test` | Unit tests; database tests also run when `TEST_DATABASE_URL` is set (`email-attachments.db.test.ts` covers the tracker's hand-off) |
| `pnpm typecheck`, `pnpm build` | Type-check; production build |
| `pnpm db:generate`, `db:migrate`, `db:deploy`, `db:studio` | Prisma. On Vercel the build runs `migrate deploy` itself, so a push applies new migrations before the new code goes live |

Database tests create a throwaway schema per file in the database at `TEST_DATABASE_URL`, so point it at a disposable database, never production.
