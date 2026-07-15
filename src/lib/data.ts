import { createClient, isDemoModeAllowed, isSupabaseConfigured } from "./supabase/client";
import { demoCompanies, demoLogs } from "./demo-data";
import type { CallLog, Company } from "./types";

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
