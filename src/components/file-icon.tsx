import { File, FileArchive, FileImage, FileSpreadsheet, FileText } from "lucide-react";
import { extensionOf } from "@/lib/file-names";

/** An icon for the kind of file, from its name and type. */
export function FileIcon({ name, mimeType, className }: { name: string; mimeType: string; className?: string }) {
  const ext = extensionOf(name);
  if (mimeType.startsWith("image/")) return <FileImage className={className} />;
  if (["xlsx", "xls", "xlsm", "csv", "tsv"].includes(ext)) return <FileSpreadsheet className={className} />;
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return <FileArchive className={className} />;
  if (mimeType === "application/pdf" || ["pdf", "doc", "docx", "txt", "md", "rtf", "odt"].includes(ext)) return <FileText className={className} />;
  return <File className={className} />;
}
