import type { Db, DbTx } from "@/lib/db";
import type { FolderAccess, Role } from "@/generated/prisma/enums";

type DefaultFolder = {
  name: string;
  nameAr: string;
  /** Claude files by this, so it says what belongs here and what does not. */
  description: string;
  restricted?: boolean;
  children?: DefaultFolder[];
};

/**
 * The company's own folders: everything that is not exchanged with one customer or supplier.
 * Trading documents (quotations, orders, invoices…) go in year folders the app creates as needed;
 * see file-kinds.ts and parties.ts.
 */
export const DEFAULT_FOLDERS: DefaultFolder[] = [
  {
    name: "Quality & Regulatory",
    nameAr: "الجودة والشؤون التنظيمية",
    description: "Our own quality and regulatory records, not tied to one customer or supplier order.",
    children: [
      {
        name: "GMP & Licences",
        nameAr: "شهادات GMP والتراخيص",
        description: "GMP certificates, manufacturing and import licences, ISO certificates, free sale certificates and inspection reports.",
      },
      {
        name: "Registration Dossiers",
        nameAr: "ملفات التسجيل",
        description: "Product registration files submitted to health authorities: dossiers, CTD modules, approvals and variations.",
      },
      {
        name: "SOPs",
        nameAr: "إجراءات التشغيل القياسية",
        description: "Standard operating procedures, work instructions and quality manuals.",
      },
    ],
  },
  {
    name: "HR",
    nameAr: "الموارد البشرية",
    description: "Employee records. Restricted to HR and management.",
    restricted: true,
    children: [
      {
        name: "Contracts",
        nameAr: "عقود الموظفين",
        description: "Employment contracts, offer letters and contract amendments for individual employees.",
      },
      {
        name: "Personnel",
        nameAr: "شؤون الموظفين",
        description: "Employee files: IDs, visas, certificates, payslips, leave and performance records.",
      },
      {
        name: "Policies",
        nameAr: "السياسات",
        description: "HR policies, the employee handbook and internal circulars to staff.",
      },
    ],
  },
  {
    name: "Legal",
    nameAr: "الشؤون القانونية",
    description: "The company's own legal documents.",
    children: [
      {
        name: "Contracts & Agreements",
        nameAr: "العقود والاتفاقيات",
        description: "Agreements that are not with a customer or supplier of goods: office lease, consultants, services, software. Contracts with a customer or supplier go under that company.",
      },
      {
        name: "Company Documents",
        nameAr: "مستندات الشركة",
        description: "Trade licence, memorandum of association, powers of attorney, registrations and other corporate records.",
      },
    ],
  },
  {
    name: "Marketing",
    nameAr: "التسويق",
    description: "Promotional material.",
    children: [
      {
        name: "Brochures",
        nameAr: "الكتيبات",
        description: "Product brochures, leaflets, catalogues and data sheets made for promotion.",
      },
      {
        name: "Presentations",
        nameAr: "العروض التقديمية",
        description: "Slide decks and company or product presentations.",
      },
    ],
  },
  {
    name: "Bank",
    nameAr: "البنك",
    description: "Bank statements, letters of credit, guarantees and other banking documents. Restricted to finance and management.",
    restricted: true,
  },
  {
    name: "General",
    nameAr: "عام",
    description: "Anything that clearly fits no other folder.",
  },
];

/**
 * Creates any default folder that is missing, matching by name under the same parent.
 * Existing folders are left untouched, so running it again is safe.
 * Returns how many folders were created.
 */
export async function seedDefaultFolders(prisma: DbTx, orgId: string, createdBy: string): Promise<number> {
  let created = 0;

  async function ensure(folders: DefaultFolder[], parentId: string | null): Promise<void> {
    for (const [index, folder] of folders.entries()) {
      let row = await prisma.folder.findFirst({
        where: { orgId, parentId, name: folder.name },
        select: { id: true },
      });
      if (!row) {
        row = await prisma.folder.create({
          data: {
            orgId,
            parentId,
            name: folder.name,
            nameAr: folder.nameAr,
            description: folder.description,
            access: folder.restricted ? "restricted" : "everyone",
            sortOrder: index,
            createdBy,
          },
          select: { id: true },
        });
        created += 1;
      }
      if (folder.children) await ensure(folder.children, row.id);
    }
  }

  await ensure(DEFAULT_FOLDERS, null);
  return created;
}

export type FolderNode = {
  id: string;
  parentId: string | null;
  name: string;
  access: FolderAccess;
  isActive: boolean;
};

type FolderGrantRow = { folderId: string; canWrite: boolean };

/**
 * Which folders a user may see and file into.
 * A restricted folder hides itself and everything under it unless the user holds a grant on it
 * (or on a restricted ancestor). Admins and owners see and write everywhere. Viewers never write.
 * Inactive folders stay visible (their files remain readable) but never accept new files.
 */
export function folderAccess(
  folders: FolderNode[],
  grants: FolderGrantRow[],
  role: Role,
): { visible: Set<string>; writable: Set<string> } {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const grantByFolder = new Map(grants.map((g) => [g.folderId, g]));
  const visible = new Set<string>();
  const writable = new Set<string>();

  for (const folder of folders) {
    let canSee = true;
    let canWrite = role !== "viewer";
    if (role !== "admin") {
      // Walk up to the root; each restricted folder on the path needs a grant.
      const seen = new Set<string>();
      for (let f: FolderNode | undefined = folder; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
        seen.add(f.id);
        if (f.access !== "restricted") continue;
        const grant = grantByFolder.get(f.id);
        if (!grant) {
          canSee = false;
          break;
        }
        if (!grant.canWrite) canWrite = false;
      }
    }
    if (!canSee) continue;
    visible.add(folder.id);
    if (canWrite && folder.isActive) writable.add(folder.id);
  }
  return { visible, writable };
}

/** Folders that are restricted themselves or sit under a restricted folder. */
export function restrictedFolderIds(folders: Pick<FolderNode, "id" | "parentId" | "access">[]): Set<string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const restricted = new Set<string>();
  for (const folder of folders) {
    const seen = new Set<string>();
    for (let f: typeof folder | undefined = folder; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
      seen.add(f.id);
      if (f.access === "restricted") {
        restricted.add(folder.id);
        break;
      }
    }
  }
  return restricted;
}

/** "Sales / Quotations" for every folder, in the folder's English names. */
export function folderPaths(folders: Pick<FolderNode, "id" | "parentId" | "name">[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let f: typeof folder | undefined = folder; f && !seen.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) {
      seen.add(f.id);
      names.unshift(f.name);
    }
    paths.set(folder.id, names.join(" / "));
  }
  return paths;
}

/** Loads the company's folders and the user's grants, then applies `folderAccess`. */
export async function loadFolderAccess(prisma: Db, orgId: string, userId: string, role: Role) {
  const [folders, grants] = await Promise.all([
    prisma.folder.findMany({
      where: { orgId },
      select: {
        id: true,
        parentId: true,
        name: true,
        nameAr: true,
        description: true,
        access: true,
        isActive: true,
        sortOrder: true,
        kind: true,
        year: true,
        side: true,
        partyId: true,
        docKind: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    role === "admin"
      ? Promise.resolve([])
      : prisma.folderGrant.findMany({
          where: { userId, folder: { orgId } },
          select: { folderId: true, canWrite: true },
        }),
  ]);
  return { folders, ...folderAccess(folders, grants, role) };
}
