"use client";

import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { confirmSummaryAction, moveFileAction, retryReadAction } from "@/app/c/[slug]/actions";
import { FileIcon } from "@/components/file-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { DOC_TYPES, DOC_TYPE_LABELS } from "@/lib/doc-types";
import type { FileKind } from "@/lib/file-kinds";
import { formatBytes } from "@/lib/file-names";
import type { FolderSuggestion, SummaryFormInput } from "@/lib/intake";

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
  suggestion: FolderSuggestion | null;
};

type Folder = { id: string; path: string };

const FIELD =
  "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function ReviewCard({ slug, file, kinds, folders, focused }: { slug: string; file: ReviewFile; kinds: FileKind[]; folders: Folder[]; focused: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState(file.step);
  const [suggestion, setSuggestion] = useState(file.suggestion);
  const card = useRef<HTMLElement>(null);

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
      </div>

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
        <FolderStep slug={slug} file={file} kinds={kinds} folders={folders} suggestion={suggestion} focused={focused} onBack={() => setStep("summary")} />
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
  onConfirmed: (suggestion: FolderSuggestion | null) => void;
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

/** `kind:<id>` or `folder:<id>`; an empty folder id while choosing. */
function answerFor(suggestion: FolderSuggestion | null, kinds: FileKind[]): string {
  if (!suggestion) return "";
  const kind = kinds.find((k) => k.folderId === suggestion.folderId);
  return kind ? `kind:${kind.id}` : `folder:${suggestion.folderId}`;
}

function FolderStep({
  slug,
  file,
  kinds,
  folders,
  suggestion,
  focused,
  onBack,
}: {
  slug: string;
  file: ReviewFile;
  kinds: FileKind[];
  folders: Folder[];
  suggestion: FolderSuggestion | null;
  focused: boolean;
  onBack: () => void;
}) {
  const router = useRouter();
  const [answer, setAnswer] = useState(() => answerFor(suggestion, kinds));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setAnswer(answerFor(suggestion, kinds)), [suggestion, kinds]);

  const groups = [...new Set(kinds.map((k) => k.group))];
  const choosingFolder = answer.startsWith("folder:");
  const folderId = answer.startsWith("kind:") ? (kinds.find((k) => k.id === answer.slice(5))?.folderId ?? "") : answer.slice(7);
  const path = folders.find((f) => f.id === folderId)?.path;

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!folderId) return;
        start(async () => {
          const result = await moveFileAction(slug, { fileId: file.id, folderId });
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
            {suggestion.reason && <>: {suggestion.reason}</>}
            {suggestion.confidence < 0.5 && <> (it is not sure)</>}. Change it if that is wrong.
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">The AI had no suggestion for this file. Choose where it belongs.</p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`kind-${file.id}`}>What is this file?</Label>
        <NativeSelect id={`kind-${file.id}`} value={choosingFolder ? "folder:" : answer} onChange={(e) => setAnswer(e.target.value)} className="w-full" autoFocus={focused}>
          <option value="" disabled>
            Choose what it is…
          </option>
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {kinds
                .filter((k) => k.group === group)
                .map((k) => (
                  <option key={k.id} value={`kind:${k.id}`}>
                    {k.label}
                  </option>
                ))}
            </optgroup>
          ))}
          <optgroup label="Not listed">
            <option value="folder:">Choose a folder myself…</option>
          </optgroup>
        </NativeSelect>
      </div>
      {choosingFolder && (
        <NativeSelect aria-label="Folder" value={answer.slice(7)} onChange={(e) => setAnswer(`folder:${e.target.value}`)} className="w-full">
          <option value="" disabled>
            Choose a folder…
          </option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </NativeSelect>
      )}
      <p className="text-muted-foreground text-sm">Goes to: {path ? <span className="text-foreground font-medium">{path}</span> : "—"}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !folderId}>
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
