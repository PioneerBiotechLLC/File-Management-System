export type FilingInput = {
  /** The folder the uploader picked, already checked as writable for them. */
  userFolderId: string | null;
  uploaderEmail: string;
  /** Claude's choice, already limited to folders the uploader may write to; null when there is none. */
  suggestion: { folderId: string | null; confidence: number } | null;
  /** FILES_AUTO_FILE_THRESHOLD. */
  threshold: number;
  aiLimitReached: boolean;
};

type FilingDecision = {
  status: "ready" | "needs_review";
  folderId: string | null;
  /** "ai" or the email of the user whose choice placed the file. */
  filedBy: string | null;
};

/**
 * Where a processed file goes.
 * - The uploader's own choice always wins; the AI only suggests.
 * - Otherwise a suggestion at or above the threshold files the file automatically.
 * - Otherwise it waits in Needs review with the suggestion pre-selected.
 * - When the daily AI limit stopped the analysis, the file needs review either way.
 */
export function decideFiling(input: FilingInput): FilingDecision {
  const userChoice = input.userFolderId ? { folderId: input.userFolderId, filedBy: input.uploaderEmail } : null;
  if (input.aiLimitReached) {
    return { status: "needs_review", folderId: userChoice?.folderId ?? null, filedBy: userChoice?.filedBy ?? null };
  }
  if (userChoice) return { status: "ready", ...userChoice };
  const { suggestion } = input;
  if (suggestion?.folderId && suggestion.confidence >= input.threshold) {
    return { status: "ready", folderId: suggestion.folderId, filedBy: "ai" };
  }
  return { status: "needs_review", folderId: null, filedBy: null };
}
