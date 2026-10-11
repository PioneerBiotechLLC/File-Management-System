"use server";

import { signIn, signOut } from "@/auth";

/** Only same-site paths, so the sign-in page cannot be used as an open redirect. */
function safePath(path: unknown): string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
}

export async function signInWithMicrosoft(formData: FormData) {
  await signIn("microsoft-entra-id", { redirectTo: safePath(formData.get("callbackUrl")) });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/signin" });
}
