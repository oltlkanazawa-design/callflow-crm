import { createClient, isDemoModeAllowed, isSupabaseConfigured } from "./supabase/client";
import { demoCompanies, demoLogs, demoMembers } from "./demo-data";
import { memberErrorMessage, filterActivePendingInvitations } from "./members";
import type { CallLog, Company, Member, MemberInvitation, MemberRole } from "./types";

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
const MEMBER_KEY = "callflow_members_v1";

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}

export interface CRMData {
  companies: Company[];
  logs: CallLog[];
  activeMembers: Member[];
  allMembers: Member[];
  pendingInvitations: MemberInvitation[];
  currentUserId: string;
  currentUser: string;
  isAdmin: boolean;
}

export async function loadCRMData(): Promise<CRMData> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const members = readLocal(MEMBER_KEY, demoMembers);
    const me = members[0];
    return {
      companies: readLocal(COMPANY_KEY, demoCompanies), logs: readLocal(LOG_KEY, demoLogs),
      activeMembers: members.filter(m => m.active), allMembers: members, pendingInvitations: [],
      currentUserId: me?.id || "", currentUser: me?.full_name || "辻 保", isAdmin: me?.role === "admin",
    };
  }
  const supabase = createClient();
  const [{ data: companies, error: ce }, { data: logs, error: le }, { data: profiles, error: pe }, { data: auth }] = await Promise.all([
    supabase.from("companies").select("*, profiles!companies_owner_id_fkey(full_name)").order("created_at", { ascending: false }),
    supabase.from("call_logs").select("*, companies(name), profiles!call_logs_caller_id_fkey(full_name)").order("created_at", { ascending: false }).limit(500),
    supabase.from("profiles").select("id,full_name,email,role,active,created_at").order("full_name"),
    supabase.auth.getUser(),
  ]);
  if (ce || le || pe) throw ce || le || pe;
  const allMembers = (profiles || []) as Member[];
  const me = allMembers.find(p => p.id === auth.user?.id);
  const currentUser = me?.full_name || "ログインユーザー";
  const isAdmin = me?.role === "admin" && me.active === true;

  // 招待一覧はadminのみRLSで閲覧できる。admin以外は元々0件が返るため
  // エラー扱いにしない。ただしテーブル未作成・RLS不整合等の本物のエラーは
  // 空配列で隠さず、はっきり例外として投げる。
  // 期限切れのpending招待（statusはまだ'pending'のまま）を「初回ログイン待ち」
  // として誤表示しないよう、expires_atが現在時刻より後のものだけを取得する。
  let pendingInvitations: MemberInvitation[] = [];
  if (isAdmin) {
    const { data: invitations, error: ie } = await supabase
      .from("member_invitations")
      .select("id,email,full_name,role,status,expires_at,created_at")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (ie) throw ie;
    pendingInvitations = filterActivePendingInvitations((invitations || []) as MemberInvitation[]);
  }

  return {
    companies: (companies || []).map((c: Record<string, unknown>) => ({ ...c, owner_name: (c.profiles as { full_name?: string } | null)?.full_name || "未割当" })) as Company[],
    logs: (logs || []).map((l: Record<string, unknown>) => ({ ...l, company_name: (l.companies as { name?: string } | null)?.name || "削除済み", caller_name: (l.profiles as { full_name?: string } | null)?.full_name || "不明" })) as CallLog[],
    activeMembers: allMembers.filter(m => m.active), allMembers, pendingInvitations,
    currentUserId: auth.user?.id || "", currentUser, isAdmin,
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

export async function inviteMember(email: string, fullName: string, role: MemberRole): Promise<Member | MemberInvitation> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const members = readLocal<Member[]>(MEMBER_KEY, demoMembers);
    const normalizedEmail = email.trim().toLowerCase();
    const name = fullName.trim();
    if (!normalizedEmail) throw new Error(memberErrorMessage("email_required"));
    if (!name) throw new Error(memberErrorMessage("full_name_required"));
    const existing = members.find(m => m.email === normalizedEmail);
    if (existing) throw new Error(memberErrorMessage(existing.active ? "already_active_member" : "inactive_member_use_reactivate"));
    // デモモードには実際のGoogleログイン受け入れフローが無いため、招待＝即座に有効なメンバーとして追加する簡略動作とする
    const member: Member = { id: crypto.randomUUID(), full_name: name, email: normalizedEmail, role, active: true, created_at: new Date().toISOString() };
    localStorage.setItem(MEMBER_KEY, JSON.stringify([...members, member]));
    return member;
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_member_invitation", { p_email: email, p_full_name: fullName, p_role: role });
  if (error) throw new Error(memberErrorMessage(error.message));
  return data as MemberInvitation;
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    return; // デモモードでは招待テーブルを使わないため何もしない
  }
  const supabase = createClient();
  const { error } = await supabase.rpc("cancel_member_invitation", { invitation_id: invitationId });
  if (error) throw new Error(memberErrorMessage(error.message));
}

export async function setMemberActive(memberId: string, active: boolean, currentUserId: string): Promise<Member> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (memberId === currentUserId) throw new Error(memberErrorMessage("cannot_change_own_active_status"));
    const members = readLocal<Member[]>(MEMBER_KEY, demoMembers);
    const target = members.find(m => m.id === memberId);
    if (!target) throw new Error(memberErrorMessage("member_not_found_in_your_organization"));
    if (!active && target.role === "admin" && target.active) {
      const remainingAdmins = members.filter(m => m.role === "admin" && m.active && m.id !== memberId).length;
      if (remainingAdmins === 0) throw new Error(memberErrorMessage("cannot_deactivate_last_admin"));
    }
    const updated = members.map(m => m.id === memberId ? { ...m, active } : m);
    localStorage.setItem(MEMBER_KEY, JSON.stringify(updated));
    return updated.find(m => m.id === memberId)!;
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_member_active", { member_id: memberId, new_active: active });
  if (error) throw new Error(memberErrorMessage(error.message));
  return data as Member;
}

export async function setMemberRole(memberId: string, role: MemberRole, currentUserId: string): Promise<Member> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (memberId === currentUserId) throw new Error(memberErrorMessage("cannot_change_own_role"));
    const members = readLocal<Member[]>(MEMBER_KEY, demoMembers);
    const target = members.find(m => m.id === memberId);
    if (!target) throw new Error(memberErrorMessage("member_not_found_in_your_organization"));
    if (role === "member" && target.role === "admin" && target.active) {
      const remainingAdmins = members.filter(m => m.role === "admin" && m.active && m.id !== memberId).length;
      if (remainingAdmins === 0) throw new Error(memberErrorMessage("cannot_demote_last_admin"));
    }
    const updated = members.map(m => m.id === memberId ? { ...m, role } : m);
    localStorage.setItem(MEMBER_KEY, JSON.stringify(updated));
    return updated.find(m => m.id === memberId)!;
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_member_role", { member_id: memberId, new_role: role });
  if (error) throw new Error(memberErrorMessage(error.message));
  return data as Member;
}

export async function updateMemberName(memberId: string, fullName: string): Promise<Member> {
  const name = fullName.trim();
  if (!name) throw new Error(memberErrorMessage("full_name_required"));
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const members = readLocal<Member[]>(MEMBER_KEY, demoMembers);
    if (!members.find(m => m.id === memberId)) throw new Error(memberErrorMessage("member_not_found_in_your_organization"));
    const updated = members.map(m => m.id === memberId ? { ...m, full_name: name } : m);
    localStorage.setItem(MEMBER_KEY, JSON.stringify(updated));
    return updated.find(m => m.id === memberId)!;
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_member_name", { member_id: memberId, new_full_name: name });
  if (error) throw new Error(memberErrorMessage(error.message));
  return data as Member;
}
