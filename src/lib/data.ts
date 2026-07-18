import { createClient, isDemoModeAllowed, isSupabaseConfigured } from "./supabase/client";
import { demoCompanies, demoLogs, demoMembers } from "./demo-data";
import { memberErrorMessage, filterActivePendingInvitations } from "./members";
import { normalizePhone, urlDomain, normalizeName } from "./csv-import";
import { companySafetyErrorMessage } from "./company-safety";
import type { OnDuplicate, CheckCompanySafetyResult, CheckedWriteResult, CreateCompaniesCheckedResult, BulkRowResult, BlocklistEntry } from "./company-safety";
import type { CallLog, Company, Member, MemberInvitation, MemberRole } from "./types";

const COMPANY_KEY = "callflow_companies_v1";
const LOG_KEY = "callflow_logs_v1";
const MEMBER_KEY = "callflow_members_v1";
const BLOCKLIST_KEY = "callflow_blocklist_v1";

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
    const companies = applyDemoBlocklist(readLocal(COMPANY_KEY, demoCompanies));
    return {
      companies, logs: readLocal(LOG_KEY, demoLogs),
      activeMembers: members.filter(m => m.active), allMembers: members, pendingInvitations: [],
      currentUserId: me?.id || "", currentUser: me?.full_name || "辻 保", isAdmin: me?.role === "admin",
    };
  }
  const supabase = createClient();
  // companies_with_call_status はLATERAL JOINを含むビューのため、PostgRESTの外部キー
  // 埋め込み（profiles!companies_owner_id_fkey等）を頼らず、profilesは別途取得して
  // owner_idから手動で名前を解決する（ビュー経由でも確実に動く方式）。
  const [{ data: companies, error: ce }, { data: logs, error: le }, { data: profiles, error: pe }, { data: auth }] = await Promise.all([
    supabase.from("companies_with_call_status").select("*").order("created_at", { ascending: false }),
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

  const ownerNameById = new Map(allMembers.map(m => [m.id, m.full_name]));
  return {
    companies: (companies || []).map((c: Record<string, unknown>) => ({ ...c, owner_name: ownerNameById.get(c.owner_id as string) || "未割当" })) as Company[],
    logs: (logs || []).map((l: Record<string, unknown>) => ({ ...l, company_name: (l.companies as { name?: string } | null)?.name || "削除済み", caller_name: (l.profiles as { full_name?: string } | null)?.full_name || "不明" })) as CallLog[],
    activeMembers: allMembers.filter(m => m.active), allMembers, pendingInvitations,
    currentUserId: auth.user?.id || "", currentUser, isAdmin,
  };
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

// ===========================================================
// 企業安全管理（重複検出・架電禁止）
// デモモードにはcall_blocklistテーブルが無いため、localStorageで最小限の
// 同等機能（企業ごとの禁止設定・電話/URL/企業名+所在地での照合）を再現する。
// ===========================================================

interface DemoBlockEntry {
  id: string; company_id: string | null;
  normalized_phone: string; normalized_domain: string; normalized_name: string; normalized_location: string;
  match_scope: string; reason: string; active: boolean; created_at: string;
}

function readBlocklist(): DemoBlockEntry[] { return readLocal<DemoBlockEntry[]>(BLOCKLIST_KEY, []); }
function writeBlocklist(list: DemoBlockEntry[]) { localStorage.setItem(BLOCKLIST_KEY, JSON.stringify(list)); }

function normalizeCompanyKeys(input: { name?: string; phone?: string; website_url?: string; location?: string }) {
  return {
    phone: normalizePhone(input.phone || ""),
    domain: urlDomain(input.website_url || ""),
    name: normalizeName(input.name || ""),
    location: normalizeName(input.location || ""),
  };
}

function matchDemoBlocklist(list: DemoBlockEntry[], keys: { phone: string; domain: string; name: string; location: string }): DemoBlockEntry | null {
  const active = list.filter(b => b.active);
  if (keys.phone) { const hit = active.find(b => b.normalized_phone === keys.phone); if (hit) return hit; }
  if (keys.domain) { const hit = active.find(b => b.normalized_domain === keys.domain); if (hit) return hit; }
  if (keys.name && keys.location) {
    const hit = active.find(b => b.match_scope !== "name_only" && b.normalized_name === keys.name && b.normalized_location === keys.location);
    if (hit) return hit;
  }
  if (keys.name) { const hit = active.find(b => b.match_scope === "name_only" && b.normalized_name === keys.name); if (hit) return hit; }
  return null;
}

function applyDemoBlocklist(companies: Company[]): Company[] {
  const list = readBlocklist();
  if (!list.length) return companies;
  return companies.map(c => {
    const match = matchDemoBlocklist(list, normalizeCompanyKeys(c));
    if (!match) return c;
    return { ...c, call_prohibited: true, blocklist_id: match.id, blocked_scope: match.match_scope, blocked_reason: match.reason };
  });
}

function findDemoDuplicate(companies: Company[], keys: { phone: string; domain: string; name: string; location: string }, excludeId?: string): Company | null {
  const pool = excludeId ? companies.filter(c => c.id !== excludeId) : companies;
  if (keys.phone) { const hit = pool.find(c => normalizePhone(c.phone) === keys.phone); if (hit) return hit; }
  if (keys.domain) { const hit = pool.find(c => urlDomain(c.website_url || "") === keys.domain); if (hit) return hit; }
  if (keys.name && keys.location) {
    const hit = pool.find(c => normalizeName(c.name) === keys.name && normalizeName(c.location) === keys.location);
    if (hit) return hit;
  }
  return null;
}

export async function checkCompanySafety(name: string, phone: string, websiteUrl: string, location: string): Promise<CheckCompanySafetyResult> {
  const keys = normalizeCompanyKeys({ name, phone, website_url: websiteUrl, location });
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const block = matchDemoBlocklist(readBlocklist(), keys);
    const dup = findDemoDuplicate(companies, keys);
    return {
      blocked: Boolean(block),
      block_matches: block ? [{ blocklist_id: block.id, matched_scope: block.match_scope, reason: block.reason }] : [],
      duplicate_candidates: dup ? [{ tier: keys.phone && normalizePhone(dup.phone) === keys.phone ? "phone" : keys.domain && urlDomain(dup.website_url || "") === keys.domain ? "domain" : "name_location", company_id: dup.id }] : [],
    };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("check_company_safety", { p_name: name, p_phone: phone, p_website_url: websiteUrl || null, p_location: location });
  if (error) throw new Error(companySafetyErrorMessage(error.message));
  return data as CheckCompanySafetyResult;
}

export interface CompanyDraftInput {
  name: string; phone: string; website_url?: string; location: string;
  industry?: string; contact_name?: string; email?: string; memo?: string; list_source?: string;
}

export async function createCompanyChecked(input: CompanyDraftInput, owner: string, onDuplicate: OnDuplicate = "skip", acknowledgeBlocklist = false): Promise<CheckedWriteResult> {
  const keys = normalizeCompanyKeys(input);
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (!keys.name) return { status: "blocked", blocklist_id: "", matched_scope: "", reason: "name_required" } as CheckedWriteResult; // 呼び出し側でerrorとして扱う
    const block = matchDemoBlocklist(readBlocklist(), keys);
    if (block && !acknowledgeBlocklist) return { status: "blocked", blocklist_id: block.id, matched_scope: block.match_scope, reason: block.reason };
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const dup = findDemoDuplicate(companies, keys);
    if (dup && onDuplicate === "skip") return { status: "skipped", existing_company_id: dup.id };
    const newCompany: Company = {
      id: crypto.randomUUID(), name: input.name, industry: input.industry || "", location: input.location, phone: input.phone,
      website_url: input.website_url || undefined, email: input.email || undefined, list_source: input.list_source,
      contact_name: input.contact_name || "", contact_department: "", heat: "低", owner_name: owner, memo: input.memo || "",
    };
    if (dup && onDuplicate === "update") {
      const updated = companies.map(c => c.id === dup.id ? { ...c, ...newCompany, id: dup.id } : c);
      localStorage.setItem(COMPANY_KEY, JSON.stringify(updated));
      return { status: "updated", company: updated.find(c => c.id === dup.id)! as unknown as Record<string, unknown> };
    }
    localStorage.setItem(COMPANY_KEY, JSON.stringify([newCompany, ...companies]));
    return { status: "inserted", company: newCompany as unknown as Record<string, unknown> };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_company_checked", {
    p_name: input.name, p_phone: input.phone, p_website_url: input.website_url || null, p_location: input.location,
    p_industry: input.industry || "", p_contact_name: input.contact_name || "", p_email: input.email || null,
    p_memo: input.memo || "", p_list_source: input.list_source || null,
    p_on_duplicate: onDuplicate, p_acknowledge_blocklist: acknowledgeBlocklist,
  });
  if (error) throw new Error(companySafetyErrorMessage(error.message));
  return data as CheckedWriteResult;
}

export interface BulkRowInput extends CompanyDraftInput { on_duplicate?: OnDuplicate }

export async function createCompaniesChecked(rows: BulkRowInput[], owner: string, defaultOnDuplicate: OnDuplicate = "skip"): Promise<CreateCompaniesCheckedResult> {
  if (!rows.length) return { results: [] };
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const blocklist = readBlocklist();
    const seenPhones = new Set<string>(), seenDomains = new Set<string>(), seenNameLocs = new Set<string>();
    const results: BulkRowResult[] = [];
    const toAdd: Company[] = [];
    let working = companies;
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const keys = normalizeCompanyKeys(row);
      const onDup = row.on_duplicate || defaultOnDuplicate;
      if (!keys.name) { results.push({ row: rowNum, status: "error", error_code: "name_required" }); return; }
      const withinCsv = (keys.phone && seenPhones.has(keys.phone)) || (keys.domain && seenDomains.has(keys.domain)) || (keys.name && keys.location && seenNameLocs.has(`${keys.name}|${keys.location}`));
      if (withinCsv) { results.push({ row: rowNum, status: "skipped", reason: "duplicate_within_csv" }); return; }
      const block = matchDemoBlocklist(blocklist, keys);
      if (block) {
        results.push({ row: rowNum, status: "blocked", blocklist_id: block.id, matched_scope: block.match_scope });
        if (keys.phone) seenPhones.add(keys.phone); if (keys.domain) seenDomains.add(keys.domain);
        if (keys.name && keys.location) seenNameLocs.add(`${keys.name}|${keys.location}`);
        return;
      }
      const dup = findDemoDuplicate([...working, ...toAdd], keys);
      if (dup && onDup === "skip") { results.push({ row: rowNum, status: "skipped", existing_company_id: dup.id }); }
      else if (dup && onDup === "update") {
        working = working.map(c => c.id === dup.id ? {
          ...c, name: row.name || c.name, phone: row.phone || c.phone, website_url: row.website_url || c.website_url,
          location: row.location || c.location, industry: row.industry || c.industry, contact_name: row.contact_name || c.contact_name,
          email: row.email || c.email, memo: row.memo || c.memo, list_source: row.list_source || c.list_source,
        } : c);
        results.push({ row: rowNum, status: "updated", company_id: dup.id });
      } else {
        const newCompany: Company = {
          id: crypto.randomUUID(), name: row.name, industry: row.industry || "", location: row.location, phone: row.phone,
          website_url: row.website_url || undefined, email: row.email || undefined, list_source: row.list_source,
          contact_name: row.contact_name || "", contact_department: "", heat: "低", owner_name: owner, memo: row.memo || "",
        };
        toAdd.push(newCompany);
        results.push({ row: rowNum, status: "inserted", company_id: newCompany.id });
      }
      if (keys.phone) seenPhones.add(keys.phone); if (keys.domain) seenDomains.add(keys.domain);
      if (keys.name && keys.location) seenNameLocs.add(`${keys.name}|${keys.location}`);
    });
    localStorage.setItem(COMPANY_KEY, JSON.stringify([...toAdd, ...working]));
    return { results };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_companies_checked", {
    p_rows: rows.map(r => ({ name: r.name, phone: r.phone, website_url: r.website_url || null, location: r.location, industry: r.industry || "", contact_name: r.contact_name || "", email: r.email || null, memo: r.memo || "", list_source: r.list_source || null, on_duplicate: r.on_duplicate })),
    p_default_on_duplicate: defaultOnDuplicate,
  });
  if (error) throw new Error(companySafetyErrorMessage(error.message));
  return data as CreateCompaniesCheckedResult;
}

export async function blockCompanyCalls(companyId: string, reason: string): Promise<BlocklistEntry> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const target = companies.find(c => c.id === companyId);
    if (!target) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    if (!reason.trim()) throw new Error(companySafetyErrorMessage("reason_required"));
    const keys = normalizeCompanyKeys(target);
    const list = readBlocklist();
    const existing = matchDemoBlocklist(list, keys);
    if (existing) return { id: existing.id, organization_id: "", company_id: existing.company_id, snapshot_name: target.name, snapshot_location: target.location, snapshot_phone: target.phone, snapshot_domain: target.website_url || null, match_scope: existing.match_scope, reason: existing.reason, note: "", active: true, created_by: "", created_at: existing.created_at, updated_by: null, updated_at: existing.created_at };
    const entry: DemoBlockEntry = { id: crypto.randomUUID(), company_id: companyId, normalized_phone: keys.phone, normalized_domain: keys.domain, normalized_name: keys.name, normalized_location: keys.location, match_scope: "phone", reason: reason.trim(), active: true, created_at: new Date().toISOString() };
    writeBlocklist([...list, entry]);
    return { id: entry.id, organization_id: "", company_id: companyId, snapshot_name: target.name, snapshot_location: target.location, snapshot_phone: target.phone, snapshot_domain: target.website_url || null, match_scope: entry.match_scope, reason: entry.reason, note: "", active: true, created_by: "", created_at: entry.created_at, updated_by: null, updated_at: entry.created_at };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("block_company_calls", { p_company_id: companyId, p_phone: null, p_website_url: null, p_name: null, p_location: null, p_match_scope: "phone", p_reason: reason });
  if (error) throw new Error(companySafetyErrorMessage(error.message));
  return data as BlocklistEntry;
}

export async function unblockCompanyCalls(blocklistId: string, reason: string): Promise<BlocklistEntry> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (!reason.trim()) throw new Error(companySafetyErrorMessage("reason_required"));
    const list = readBlocklist();
    const target = list.find(b => b.id === blocklistId && b.active);
    if (!target) throw new Error(companySafetyErrorMessage("blocklist_entry_not_found"));
    writeBlocklist(list.map(b => b.id === blocklistId ? { ...b, active: false } : b));
    return { id: target.id, organization_id: "", company_id: target.company_id, snapshot_name: null, snapshot_location: null, snapshot_phone: null, snapshot_domain: null, match_scope: target.match_scope, reason: target.reason, note: "", active: false, created_by: "", created_at: target.created_at, updated_by: null, updated_at: new Date().toISOString() };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("unblock_company_calls", { p_blocklist_id: blocklistId, p_reason: reason });
  if (error) throw new Error(companySafetyErrorMessage(error.message));
  return data as BlocklistEntry;
}
