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

export const DEFAULT_FOLDERS: DefaultFolder[] = [
  {
    name: "Sales",
    nameAr: "المبيعات",
    description: "Documents about selling our products to customers.",
    children: [
      {
        name: "Quotations",
        nameAr: "عروض الأسعار",
        description: "Price quotations, offers and proforma invoices that we send to customers. We are the seller.",
      },
      {
        name: "Customer Purchase Orders",
        nameAr: "أوامر شراء العملاء",
        description: "Purchase orders and order confirmations that customers send to us. We are the seller.",
      },
      {
        name: "Price Lists",
        nameAr: "قوائم الأسعار",
        description: "Our own price lists and tender price schedules for customers.",
      },
      {
        name: "Customer Correspondence",
        nameAr: "مراسلات العملاء",
        description: "Letters, complaints, enquiries and other correspondence with customers that is not a quotation, order or invoice.",
      },
    ],
  },
  {
    name: "Purchasing",
    nameAr: "المشتريات",
    description: "Documents about buying goods and services from suppliers.",
    children: [
      {
        name: "Supplier Quotations",
        nameAr: "عروض أسعار الموردين",
        description: "Quotations, offers and proforma invoices we receive from suppliers. We are the buyer.",
      },
      {
        name: "Purchase Orders",
        nameAr: "أوامر الشراء",
        description: "Purchase orders that we issue to suppliers, and the suppliers' order confirmations.",
      },
      {
        name: "Supplier Invoices",
        nameAr: "فواتير الموردين",
        description: "Invoices, credit notes and statements of account that suppliers send to us for payment.",
      },
    ],
  },
  {
    name: "Quality & Regulatory",
    nameAr: "الجودة والشؤون التنظيمية",
    description: "Quality control, compliance and product registration documents.",
    children: [
      {
        name: "Certificates of Analysis",
        nameAr: "شهادات التحليل",
        description: "Certificates of analysis (COA) and test reports for a product batch or lot, from us or from a manufacturer.",
      },
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
    name: "Logistics",
    nameAr: "الخدمات اللوجستية",
    description: "Moving goods: shipping, customs and delivery.",
    children: [
      {
        name: "Shipping Documents",
        nameAr: "مستندات الشحن",
        description: "Bills of lading, airway bills, packing lists, certificates of origin and shipping instructions.",
      },
      {
        name: "Customs",
        nameAr: "الجمارك",
        description: "Customs declarations, clearance documents, duty payments and import or export permits.",
      },
      {
        name: "Delivery Notes",
        nameAr: "إشعارات التسليم",
        description: "Delivery notes, goods received notes and proofs of delivery.",
      },
    ],
  },
  {
    name: "Finance",
    nameAr: "المالية",
    description: "Money in and out of the company.",
    children: [
      {
        name: "Invoices Issued",
        nameAr: "الفواتير الصادرة",
        description: "Tax invoices and credit notes that we issue to customers.",
      },
      {
        name: "Payments & Receipts",
        nameAr: "المدفوعات والإيصالات",
        description: "Payment vouchers, receipts, remittance advices and cheque copies.",
      },
      {
        name: "Bank",
        nameAr: "البنك",
        description: "Bank statements, letters of credit, guarantees and other banking documents.",
        restricted: true,
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
    description: "Agreements and the company's own legal documents.",
    children: [
      {
        name: "Contracts & Agreements",
        nameAr: "العقود والاتفاقيات",
        description: "Commercial contracts: distribution, supply, agency, lease, service and confidentiality agreements. Not employment contracts.",
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
      select: { id: true, parentId: true, name: true, nameAr: true, description: true, access: true, isActive: true, sortOrder: true },
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
