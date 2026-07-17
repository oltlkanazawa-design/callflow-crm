import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invitationErrorCode } from "@/lib/members";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${url.origin}/login?error=oauth_callback`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${url.origin}/login?error=oauth_callback`);
  }

  // Googleログイン成功後、招待の受け入れ／既存メンバーのemail同期を行う。
  // 招待が無い・利用停止中・メール未確認の場合は、セッションを破棄してから
  // 理由付きでログイン画面へ戻す（RLSでデータには到達できないが、
  // セッション自体も残さない二重の防御とする）。
  const { error: acceptError } = await supabase.rpc("accept_pending_invitation");
  if (acceptError) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${url.origin}/login?error=${invitationErrorCode(acceptError.message)}`);
  }

  return NextResponse.redirect(`${url.origin}/dashboard`);
}
