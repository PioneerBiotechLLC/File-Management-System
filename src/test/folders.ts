import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Plain folders the database tests file into. They are not defaults (trading documents live under
 * year folders now); tests just need some open folders with familiar names.
 */
const TEST_FOLDERS: Record<string, string[]> = {
  Sales: ["Quotations", "Price Lists"],
  Purchasing: ["Supplier Quotations", "Purchase Orders"],
  Logistics: ["Delivery Notes"],
};

export async function addTestFolders(prisma: PrismaClient, orgId: string): Promise<void> {
  for (const [top, children] of Object.entries(TEST_FOLDERS)) {
    const parent = await prisma.folder.create({ data: { orgId, parentId: null, name: top, description: `${top} documents.`, createdBy: "test" } });
    for (const name of children) {
      await prisma.folder.create({ data: { orgId, parentId: parent.id, name, description: `${name}.`, createdBy: "test" } });
    }
  }
}
