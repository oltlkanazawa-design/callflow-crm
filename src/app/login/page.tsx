"use client";

import { useState } from "react";
import { LockKeyhole, PhoneCall } from "lucide-react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

// auth/callbackがaccept_pending_invitation()の結果をもとに付与するエラーコード
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  no_invitation: "招待されたメールアドレスでログインしてください。管理者にご確認ください。",
  account_inactive: "このアカウントは利用停止中です。管理者にお問い合わせください。",
  email_not_confirmed: "Googleアカウントのメールアドレスが確認されていません。",
  ambiguous_invitation_state: "招待の状態を確認できませんでした。管理者にお問い合わせください。",
  oauth_callback: "Googleログインを完了できませんでした。時間をおいて再度お試しください。",
  system_error: "システムエラーによりログインを完了できませんでした。管理者にお問い合わせください。",
};

function initialLoginError():string{
 if(typeof window==="undefined")return "";
 const code=new URLSearchParams(window.location.search).get("error");
 return code?(LOGIN_ERROR_MESSAGES[code]||"ログインできませんでした。時間をおいて再度お試しください。"):"";
}

export default function LoginPage(){
 const [error,setError]=useState(initialLoginError);const [busy,setBusy]=useState(false);
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError("");if(!isSupabaseConfigured){setError("Googleログインを利用するには、Supabaseの環境変数を設定してください。");setBusy(false);return}const {error}=await createClient().auth.signInWithOAuth({provider:"google",options:{redirectTo:`${window.location.origin}/auth/callback?next=/dashboard`}});if(error){setError("Googleログインを開始できませんでした。時間をおいて再度お試しください。");setBusy(false)}};
 return <main className="grid min-h-screen lg:grid-cols-2"><section className="hidden bg-[#111a2e] p-16 text-white lg:flex lg:flex-col lg:justify-between"><div className="flex items-center gap-3 text-xl font-extrabold"><span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-blue-400 to-violet-600 text-sm">CF</span>CallFlow</div><div><div className="mb-6 grid size-16 place-items-center rounded-2xl bg-blue-500/15"><PhoneCall className="size-8 text-blue-400"/></div><h1 className="max-w-lg text-4xl font-extrabold leading-tight">架電からアポ獲得まで、<br/>チームの動きをひとつに。</h1><p className="mt-5 max-w-md text-sm leading-7 text-slate-400">企業リスト、通話記録、AI要約、フォロー予定、チーム実績を一元管理するテレアポ専用CRM。</p></div><p className="text-[10px] text-slate-600">© 2026 CallFlow CRM</p></section><section className="grid place-items-center p-6"><form onSubmit={submit} className="w-full max-w-sm"><div className="mb-8 lg:hidden"><b className="text-xl">CallFlow</b></div><p className="text-xs font-bold text-blue-600">WELCOME BACK</p><h2 className="mt-2 text-3xl font-extrabold">ログイン</h2><p className="mt-2 text-sm text-slate-500">営業チームのワークスペースへ</p>{error&&<p className="mt-8 rounded-lg bg-red-50 p-3 text-xs text-red-600">{error}</p>}<button type="submit" disabled={busy||!isSupabaseConfigured} className="btn btn-primary mt-8 w-full py-3 disabled:opacity-50">{busy?"Googleへ移動中…":"Googleでログイン"}</button>{!isSupabaseConfigured&&<p className="mt-3 text-center text-[10px] text-red-600"><LockKeyhole className="mr-1 inline size-3"/>Vercelの環境変数にSupabase URLとキーを設定してください。</p>}</form></section></main>
}
