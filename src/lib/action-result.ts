import { z } from "zod";
import { UserError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/permissions";

/**
 * Server actions return errors as data: Next.js hides the message of a thrown error in production,
 * and these are problems the person can fix ("that folder is full of..."), not crashes.
 */
type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof UserError) return { ok: false, error: error.message };
    if (error instanceof ForbiddenError) return { ok: false, error: "You do not have permission to do that." };
    if (error instanceof z.ZodError) return { ok: false, error: "Something in the request was not valid. Please try again." };
    throw error;
  }
}
