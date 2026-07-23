// ログイン画面の「デモ版を開く」導線を表示すべきかどうかの判定。
// Supabase設定済みの本番環境では常にfalse（Googleログインのみ表示）。
// Supabase未設定でも、NEXT_PUBLIC_ALLOW_DEMO=falseで明示的にデモを禁止した場合はfalse。
export function shouldShowDemoEntry(isSupabaseConfigured: boolean, isDemoModeAllowed: boolean): boolean {
  return !isSupabaseConfigured && isDemoModeAllowed;
}
