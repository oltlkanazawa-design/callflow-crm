import { createBrowserClient } from "@supabase/ssr";

export const isSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
  !process.env.NEXT_PUBLIC_SUPABASE_URL.includes("YOUR_PROJECT")
);

export const isDemoModeAllowed = process.env.NEXT_PUBLIC_ALLOW_DEMO !== "false";

export function createClient() {
  if (!isSupabaseConfigured) throw new Error("Supabase is not configured");
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
