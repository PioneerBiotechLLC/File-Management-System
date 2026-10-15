export const REFILE_SCOPES = [
  { id: "technical", label: "Technical documents", hint: "everything under Technical (manufacturer / material)" },
  { id: "commercial", label: "Customer and supplier documents", hint: "everything under year / Customers or Suppliers" },
  { id: "company", label: "Company folders", hint: "files in our own folders (Quality, HR…)" },
  { id: "review", label: "Left in Review", hint: "read files the AI was unsure about" },
] as const;
export type RefileScope = (typeof REFILE_SCOPES)[number]["id"];

export type RefileItem = { id: string; name: string; path: string };
