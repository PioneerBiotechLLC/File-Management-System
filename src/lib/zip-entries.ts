import { BlobReader, BlobWriter, ZipReader, configure } from "@zip.js/zip.js";
import { mimeTypeFromName } from "@/lib/file-names";

/**
 * Zip archives chosen for bulk upload are opened in the browser, so each document inside is
 * uploaded and filed on its own and the zip itself is never stored. Only the zip's directory is
 * read up front; each document is unpacked when its turn to upload comes, so a large archive is
 * never held in memory whole.
 */

// Workers would need a blob: worker the CSP does not allow; the browser's DecompressionStream does the work.
configure({ useWebWorkers: false });

export type ZipEntry = {
  name: string;
  /** The zip's own path, then the path inside it: "Orders.zip/2025/PO-4512.pdf". */
  relPath: string;
  size: number;
  /** Why it cannot be uploaded, if so. */
  problem?: string;
  load: () => Promise<File>;
};

/** Zips inside zips are opened too, this many levels deep; deeper ones are uploaded as they are. */
const MAX_DEPTH = 3;
/** What macOS adds to the zips it makes. */
const MAC_EXTRAS = /(^|\/)__MACOSX\//;

export const isZipName = (name: string) => /\.zip$/i.test(name.trim());

/** The documents in a zip, or null when it cannot be opened (damaged, or not really a zip). */
export async function zipEntries(zip: Blob, relPath: string, depth = 1): Promise<ZipEntry[] | null> {
  let entries;
  try {
    entries = await new ZipReader(new BlobReader(zip)).getEntries();
  } catch {
    return null;
  }
  const out: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.directory) continue;
    const inner = entry.filename.replaceAll("\\", "/");
    const name = inner.split("/").pop() ?? "";
    if (!name || MAC_EXTRAS.test(inner)) continue;
    const path = `${relPath}/${inner}`;
    const load = async () => new File([await entry.getData(new BlobWriter())], name, { type: mimeTypeFromName(name), lastModified: entry.lastModDate.getTime() });
    if (entry.encrypted) {
      out.push({ name, relPath: path, size: entry.uncompressedSize, problem: "Password-protected inside the zip", load });
      continue;
    }
    if (isZipName(name) && depth < MAX_DEPTH) {
      const nested = await load()
        .then((file) => zipEntries(file, path, depth + 1))
        .catch(() => null);
      if (nested) {
        out.push(...nested);
        continue;
      }
    }
    out.push({ name, relPath: path, size: entry.uncompressedSize, load });
  }
  return out;
}
