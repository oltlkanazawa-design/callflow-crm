import { createClient, isDemoModeAllowed, isSupabaseConfigured } from "./supabase/client";
import { demoCompanies, demoLogs } from "./demo-data";
import type { CallLog, Company } from "./types";

// Supabaseの技術的なエラーメッセージのうち、既知のパターンは営業担当にも分かる文言へ変換する
function friendlyDbErrorMessage(error: { message?: string } | null | undefined, fallback: string): string {
  const msg = error?.message || "";
  if (/email/i.test(msg) && /(does not exist|could not find)/i.test(msg)) {
    return "emailの列がデータベースにまだ追加されていません（add-company-email-column.sqlの実行が必要です）";
  }
  return msg || fallback;
}

const COMPANY_KEY = "callflow_companies_v1";
const LOG_KEY = "callflow_logs_v1";

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}

export async function loadCRMData(): Promise<{ companies: Company[]; logs: CallLog[]; members: string[]; currentUser: string }> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    return { companies: readLocal(COMPANY_KEY, demoCompanies), logs: readLocal(LOG_KEY, demoLogs), members: ["辻 保","山田 花子","佐藤 健","高橋 美咲"], currentUser:"辻 保" };
  }
  const supabase = createClient();
  const [{ data: companies, error: ce }, { data: logs, error: le }, { data: profiles, error: pe }, { data: auth }] = await Promise.all([
    supabase.from("companies").select("*, profiles!companies_owner_id_fkey(full_name)").order("created_at", { ascending: false }),
    supabase.from("call_logs").select("*, companies(name), profiles!call_logs_caller_id_fkey(full_name)").order("created_at", { ascending: false }).limit(500),
    supabase.from("profiles").select("id,full_name").eq("active",true).order("full_name"),
    supabase.auth.getUser(),
  ]);
  if (ce || le || pe) throw ce || le || pe;
  const currentUser=(profiles||[]).find(p=>p.id===auth.user?.id)?.full_name||"ログインユーザー";
  return {
    companies: (companies || []).map((c: Record<string, unknown>) => ({ ...c, owner_name: (c.profiles as { full_name?: string } | null)?.full_name || "未割当" })) as Company[],
    logs: (logs || []).map((l: Record<string, unknown>) => ({ ...l, company_name: (l.companies as { name?: string } | null)?.name || "削除済み", caller_name: (l.profiles as { full_name?: string } | null)?.full_name || "不明" })) as CallLog[],
    members:(profiles||[]).map(p=>p.full_name), currentUser,
  };
}

export async function saveCompany(company: Company): Promise<Company> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const current = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    localStorage.setItem(COMPANY_KEY, JSON.stringify([company, ...current]));
    return company;
  }
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("ログインが必要です");
  const { data: profile, error: profileError } = await supabase.from("profiles").select("organization_id,id").eq("id",auth.user.id).single();
  if (profileError) throw profileError;
  const { data, error } = await supabase.from("companies").insert({
    organization_id: profile!.organization_id, name: company.name, industry: company.industry,
    location: company.location, phone: company.phone, website_url: company.website_url || null,
    source_url: company.source_url || null, list_source: company.list_source || null, contact_name: company.contact_name,
    contact_department: company.contact_department, heat: company.heat, memo: company.memo,
    owner_id: profile!.id,
  }).select().single();
  if (error) throw error;
  return { ...data, owner_name: company.owner_name } as Company;
}

export async function saveCompaniesBulk(companies: Company[]): Promise<{ saved: Company[]; errors: { index: number; message: string }[] }> {
  if (!companies.length) return { saved: [], errors: [] };
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    try {
      const current = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
      localStorage.setItem(COMPANY_KEY, JSON.stringify([...companies, ...current]));
      return { saved: companies, errors: [] };
    } catch (e) {
      return { saved: [], errors: companies.map((_, index) => ({ index, message: e instanceof Error ? e.message : "保存に失敗しました" })) };
    }
  }
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("ログインが必要です");
  const { data: profile, error: profileError } = await supabase.from("profiles").select("organization_id,id").eq("id", auth.user.id).single();
  if (profileError) throw profileError;

  const toRow = (c: Company) => ({
    organization_id: profile!.organization_id, name: c.name, industry: c.industry, location: c.location, phone: c.phone,
    website_url: c.website_url || null, source_url: c.source_url || null, list_source: c.list_source || null, email: c.email || null,
    contact_name: c.contact_name, contact_department: c.contact_department, heat: c.heat, memo: c.memo, owner_id: profile!.id,
  });

  const saved: Company[] = [];
  const errors: { index: number; message: string }[] = [];
  const chunkSize = 25;
  for (let start = 0; start < companies.length; start += chunkSize) {
    const chunk = companies.slice(start, start + chunkSize);
    const { data, error } = await supabase.from("companies").insert(chunk.map(toRow)).select();
    if (!error && data) {
      saved.push(...(data.map((d, i) => ({ ...d, owner_name: chunk[i].owner_name })) as Company[]));
      continue;
    }
    // チャンク全体のinsertが失敗した場合のみ、原因の行を特定するため1件ずつ登録し直す
    for (let i = 0; i < chunk.length; i++) {
      const { data: single, error: singleError } = await supabase.from("companies").insert(toRow(chunk[i])).select().single();
      if (singleError) errors.push({ index: start + i, message: friendlyDbErrorMessage(singleError, "登録に失敗しました") });
      else saved.push({ ...single, owner_name: chunk[i].owner_name } as Company);
    }
  }
  return { saved, errors };
}

export async function updateCompany(id: string, patch: Partial<Omit<Company, "id" | "owner_name">>): Promise<Company> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const current = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const updated = current.map(c => c.id === id ? { ...c, ...patch } : c);
    localStorage.setItem(COMPANY_KEY, JSON.stringify(updated));
    return updated.find(c => c.id === id)!;
  }
  const supabase = createClient();
  const { data, error } = await supabase.from("companies").update(patch).eq("id", id).select().single();
  if (error) throw new Error(friendlyDbErrorMessage(error, "更新に失敗しました"));
  return { ...data, owner_name: "" } as Company;
}

export async function saveCallLog(log: CallLog, company: Company): Promise<void> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const logs = readLocal<CallLog[]>(LOG_KEY, demoLogs);
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies).map(c => c.id === company.id ? company : c);
    localStorage.setItem(LOG_KEY, JSON.stringify([log, ...logs]));
    localStorage.setItem(COMPANY_KEY, JSON.stringify(companies));
    return;
  }
  const supabase = createClient();
  const { error } = await supabase.rpc("record_call",{p_company_id:company.id,p_result:log.result,p_note:log.note,p_transcript:log.transcript||null,p_ai_summary:log.ai_summary||null,p_next_action_at:log.next_action_at||null,p_heat:company.heat});
  if (error) throw error;
}
