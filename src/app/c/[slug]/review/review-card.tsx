"use client";

import { AlertTriangle, Loader2, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { confirmSummaryAction, deleteFileAction, fileToAction, retryReadAction } from "@/app/c/[slug]/actions";
import { DestinationPicker, draftFrom, resolveDraft } from "@/components/destination-picker";
import { FileIcon } from "@/components/file-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { DOC_TYPES, DOC_TYPE_LABELS, type DocType } from "@/lib/doc-types";
import { SIDE_FOLDERS, TECHNICAL_DOC_TYPES, docKindForType, techKindForType, type FilingSuggestion, type MaterialChoice, type PartyChoice } from "@/lib/file-kinds";
import { formatBytes } from "@/lib/file-names";
import type { SummaryFormInput } from "@/lib/intake";

export type ReviewFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploader: string;
  uploadedAt: string;
  /** "reading": the AI is on it; "summary": needs checking or writing; "folder": summary confirmed. */
  step: "reading" | "summary" | "folder";
  readByAi: boolean;
  /** Why the AI did not read the file, when it did not. */
  aiNote: string | null;
  retryable: boolean;
  form: SummaryFormInput;
  suggestion: FilingSuggestion | null;
};

type Folder = { id: string; path: string };

const FIELD =
  "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function ReviewCard({
  slug,
  file,
  parties,
  materials,
  folders,
  focused,
}: {
  slug: string;
  file: ReviewFile;
  parties: PartyChoice[];
  materials: MaterialChoice[];
  folders: Folder[];
  focused: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(file.step);
  const [suggestion, setSuggestion] = useState(file.suggestion);
  const [removing, startRemove] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);

  // Uploaded by mistake: it goes to Deleted (restorable for 30 days) without ever being filed.
  const remove = () => {
    if (!window.confirm(`Remove "${file.name}"? It will not be filed; you can restore it from Deleted within 30 days.`)) return;
    startRemove(async () => {
      const result = await deleteFileAction(slug, { fileId: file.id });
      if (result.ok) router.refresh();
      else setRemoveError(result.error);
    });
  };

  // The server's view wins when it changes (a read finishing, another tab confirming).
  useEffect(() => {
    setStep(file.step);
    setSuggestion(file.suggestion);
  }, [file.step, file.suggestion]);

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focused]);

  return (
    <section ref={card} id={`file-${file.id}`} className="bg-card grid gap-4 rounded-xl border p-5 shadow-sm">
      <div className="flex items-start gap-2">
        <FileIcon name={file.name} mimeType={file.mimeType} className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <Link href={`/c/${slug}/files/${file.id}`} dir="auto" className="block truncate font-medium hover:underline">
            {file.name}
          </Link>
          <p className="text-muted-foreground text-xs">
            {formatBytes(file.sizeBytes)} · {file.uploader} · {file.uploadedAt}
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">{step === "folder" ? "Step 2 of 2" : "Step 1 of 2"}</span>
        <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive -mt-1 -mr-2 size-8 shrink-0" onClick={remove} disabled={removing} aria-label="Remove this file">
          {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>
      {removeError && (
        <p role="alert" className="text-destructive text-sm">
          {removeError}
        </p>
      )}

      {step === "reading" && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          The AI is reading this file. This usually takes 5–30 seconds.
        </p>
      )}
      {step === "summary" && (
        <SummaryStep
          slug={slug}
          file={file}
          focused={focused}
          onConfirmed={(s) => {
            setSuggestion(s);
            setStep("folder");
            router.refresh();
          }}
          onRetry={() => setStep("reading")}
        />
      )}
      {step === "folder" && (
        <FolderStep slug={slug} file={file} parties={parties} materials={materials} folders={folders} suggestion={suggestion} focused={focused} onBack={() => setStep("summary")} />
      )}
    </section>
  );
}

function SummaryStep({
  slug,
  file,
  focused,
  onConfirmed,
  onRetry,
}: {
  slug: string;
  file: ReviewFile;
  focused: boolean;
  onConfirmed: (suggestion: FilingSuggestion | null) => void;
  onRetry: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const retry = () =>
    start(async () => {
      const result = await retryReadAction(slug, { fileId: file.id });
      if (!result.ok) return setError(result.error);
      onRetry();
      await fetch(`/c/${slug}/files/${file.id}/analyze`, { method: "POST" }).catch(() => undefined);
      router.refresh();
    });

  return (
    <form
      className="grid gap-4"
      action={(formData) =>
        start(async () => {
          const field = (name: string) => String(formData.get(name) ?? "");
          const result = await confirmSummaryAction(slug, {
            fileId: file.id,
            title: field("title"),
            summary: field("summary"),
            docType: field("docType") as SummaryFormInput["docType"],
            docDate: field("docDate"),
            parties: field("parties"),
            references: field("references"),
            amounts: field("amounts"),
            products: field("products"),
            items: field("items"),
            expiryDate: field("expiryDate"),
            tags: field("tags"),
          });
          if (result.ok) onConfirmed(result.data.suggestion);
          else setError(result.error);
        })
      }
    >
      {file.readByAi ? (
        <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm">
          <Sparkles className="text-brand mt-0.5 size-4 shrink-0" />
          <span>The AI read this file and filled in the summary. Check every field, fix anything wrong, then confirm.</span>
        </p>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {file.aiNote ? <>The AI could not read this file: {file.aiNote}</> : <>The AI did not read this file.</>} Please write the summary yourself.
            {file.retryable && (
              <>
                {" "}
                <button type="button" onClick={retry} disabled={pending} className="font-medium underline">
                  Try again with AI
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`title-${file.id}`}>Title</Label>
        <Input id={`title-${file.id}`} name="title" defaultValue={file.form.title} maxLength={200} autoFocus={focused} placeholder="e.g. Quotation QT-2291 for Gulf Pharmacy" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`summary-${file.id}`}>Summary</Label>
        <textarea
          id={`summary-${file.id}`}
          name="summary"
          dir="auto"
          rows={4}
          required
          maxLength={2000}
          defaultValue={file.form.summary}
          placeholder="What this document is, who it is from and to, its date, the prices and the materials or products"
          className={`${FIELD} min-h-24`}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`docType-${file.id}`}>Type</Label>
          <NativeSelect id={`docType-${file.id}`} name="docType" defaultValue={file.form.docType}>
            <option value="">Not set</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`docDate-${file.id}`}>Document date</Label>
          <Input id={`docDate-${file.id}`} name="docDate" type="date" defaultValue={file.form.docDate} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`parties-${file.id}`}>From / to (one per line)</Label>
          <textarea id={`parties-${file.id}`} name="parties" dir="auto" rows={2} defaultValue={file.form.parties} placeholder={"API Pharma\nGulf Pharmacy LLC"} className={FIELD} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`references-${file.id}`}>Reference numbers (one per line)</Label>
          <textarea id={`references-${file.id}`} name="references" dir="auto" rows={2} defaultValue={file.form.references} placeholder={"quotation QT-2291\nbatch B2291"} className={FIELD} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`products-${file.id}`}>Materials and products (one per line)</Label>
          <textarea id={`products-${file.id}`} name="products" dir="auto" rows={2} defaultValue={file.form.products} placeholder={"Insulin glargine 100 IU/ml\nMetformin 500 mg"} className={FIELD} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`amounts-${file.id}`}>Prices and totals</Label>
          <Input id={`amounts-${file.id}`} name="amounts" defaultValue={file.form.amounts} placeholder="1,250.50 AED, 300 USD" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`items-${file.id}`}>Line items (one per line: description | quantity | unit price | total)</Label>
        <textarea
          id={`items-${file.id}`}
          name="items"
          dir="auto"
          rows={3}
          defaultValue={file.form.items}
          placeholder={"Maize Starch 16000 kg | 16000 kg | 7.50 AED | 120000 AED\nDMEM 500 ml | 200 bottles | 14.70 EUR"}
          className={FIELD}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`expiry-${file.id}`}>Expiry date (if any)</Label>
          <Input id={`expiry-${file.id}`} name="expiryDate" type="date" defaultValue={file.form.expiryDate} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`tags-${file.id}`}>Tags</Label>
          <Input id={`tags-${file.id}`} name="tags" defaultValue={file.form.tags} placeholder="customer, product, country" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Confirm summary"}
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function FolderStep({
  slug,
  file,
  parties,
  materials,
  folders,
  suggestion,
  focused,
  onBack,
}: {
  slug: string;
  file: ReviewFile;
  parties: PartyChoice[];
  materials: MaterialChoice[];
  folders: Folder[];
  suggestion: FilingSuggestion | null;
  focused: boolean;
  onBack: () => void;
}) {
  const router = useRouter();
  const docType = (file.form.docType || null) as DocType | null;
  const fallback = {
    year: Number(file.form.docDate.slice(0, 4)) || new Date().getFullYear(),
    docKind: docKindForType(docType),
    techKind: techKindForType(docType),
    technical: docType !== null && TECHNICAL_DOC_TYPES.includes(docType),
  };
  const [draft, setDraft] = useState(() => draftFrom(suggestion?.destination ?? null, fallback));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A new suggestion (after editing the summary) replaces the draft.
  useEffect(() => setDraft(draftFrom(suggestion?.destination ?? null, fallback)), [suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolved = resolveDraft(draft, parties, folders, materials);

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!resolved) return;
        start(async () => {
          // Teach the new spelling only when the uploader kept the AI's company.
          const seenAs = suggestion?.seenAs && resolved.destination.kind === "trading" && resolved.destination.partyId === (suggestion.destination as { partyId?: string | null }).partyId ? suggestion.seenAs : null;
          const result = await fileToAction(slug, { fileId: file.id, destination: resolved.destination, seenAs });
          if (!result.ok) return setError(result.error);
          if (focused) router.push(`/c/${slug}/files/${file.id}`);
          else router.refresh();
        });
      }}
    >
      {suggestion ? (
        <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm">
          <Sparkles className="text-brand mt-0.5 size-4 shrink-0" />
          <span>
            The AI suggests <span className="font-medium">{suggestion.path}</span>
            {suggestion.newParty && <> (a new {suggestion.destination.kind === "trading" ? SIDE_FOLDERS[suggestion.destination.side].label.toLowerCase() : "folder"})</>}
            {suggestion.reason && <>: {suggestion.reason}</>}
            {suggestion.confidence < 0.5 && <> (it is not sure)</>}. Change it if that is wrong.
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">The AI had no suggestion for this file. Choose where it belongs.</p>
      )}
      <DestinationPicker draft={draft} onChange={setDraft} parties={parties} materials={materials} folders={folders} autoFocus={focused} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !resolved}>
          {pending ? "Filing…" : "Save here"}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Edit summary
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
