"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Reloads the page every few seconds while a file is being read, so the draft appears when it is ready. */
export function ReadingWatch({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 4_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
