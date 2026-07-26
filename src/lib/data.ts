import { createClient, isDemoModeAllowed, isSupabaseConfigured } from "./supabase/client";
import { demoCompanies, demoLogs, demoMembers } from "./demo-data";
import { memberErrorMessage, filterActivePendingInvitations } from "./members";
import { normalizePhone, urlDomain, normalizeName } from "./csv-import";
import { companySafetyErrorMessage } from "./company-safety";
import type { OnDuplicate, MatchScope, CheckCompanySafetyResult, CheckedWriteResult, CreateCompaniesCheckedResult, BulkRowResult, BlocklistEntry, ArchiveCompanyResult, RestoreCompanyResult, BulkArchiveCompaniesResult } from "./company-safety";
import { dedupeCompanyIds, MAX_BULK_ARCHIVE_IDS } from "./bulk-archive";
import type { CallLog, Company, Heat, Member, MemberInvitation, MemberRole } from "./types";

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
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
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
  normalized_phone: string | null; normalized_domain: string | null;
  normalized_name: string | null; normalized_location: string | null;
  match_scope: MatchScope; reason: string; active: boolean; created_at: string;
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

// match_scopeを厳密に適用する。SQL側のmatch_active_blocklist()と同じ優先順位・
// 同じ判定（保存列の非NULLだけに頼らず、match_scopeそのものも必ず確認する）
function matchDemoBlocklist(list: DemoBlockEntry[], keys: { phone: string; domain: string; name: string; location: string }): DemoBlockEntry | null {
  const active = list.filter(b => b.active);
  if (keys.phone) {
    const hit = active.find(b => (b.match_scope === "phone" || b.match_scope === "strict") && b.normalized_phone === keys.phone);
    if (hit) return hit;
  }
  if (keys.domain) {
    const hit = active.find(b => (b.match_scope === "domain" || b.match_scope === "strict") && b.normalized_domain === keys.domain);
    if (hit) return hit;
  }
  if (keys.name && keys.location) {
    const hit = active.find(b => (b.match_scope === "name_location" || b.match_scope === "strict") && b.normalized_name === keys.name && b.normalized_location === keys.location);
    if (hit) return hit;
  }
  if (keys.name) {
    const hit = active.find(b => b.match_scope === "name_only" && b.normalized_name === keys.name);
    if (hit) return hit;
  }
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

const VALID_ON_DUPLICATE: OnDuplicate[] = ["skip", "update", "insert"];

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
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as CheckCompanySafetyResult;
}

export interface CompanyDraftInput {
  name: string; phone: string; website_url?: string; location: string;
  industry?: string; contact_name?: string; email?: string; memo?: string; list_source?: string;
}

// 禁止先に一致した企業は、いかなる引数によっても登録を迂回できない
// （p_acknowledge_blocklistのような迂回引数は存在しない）
export async function createCompanyChecked(input: CompanyDraftInput, owner: string, onDuplicate: OnDuplicate = "skip"): Promise<CheckedWriteResult> {
  if (!VALID_ON_DUPLICATE.includes(onDuplicate)) throw new Error(companySafetyErrorMessage("invalid_on_duplicate"));
  const keys = normalizeCompanyKeys(input);
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (!keys.name) throw new Error(companySafetyErrorMessage("name_required"));
    const block = matchDemoBlocklist(readBlocklist(), keys);
    if (block) return { status: "blocked", blocklist_id: block.id, matched_scope: block.match_scope, reason: block.reason };
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const dup = findDemoDuplicate(companies, keys);
    if (dup && onDuplicate === "skip") return { status: "skipped", existing_company_id: dup.id };
    if (dup && onDuplicate === "update") return { status: "needs_explicit_update", existing_company_id: dup.id };
    const newCompany: Company = {
      id: crypto.randomUUID(), name: input.name, industry: input.industry || "", location: input.location, phone: input.phone,
      website_url: input.website_url || undefined, email: input.email || undefined, list_source: input.list_source,
      contact_name: input.contact_name || "", contact_department: "", heat: "低", owner_name: owner, memo: input.memo || "",
    };
    localStorage.setItem(COMPANY_KEY, JSON.stringify([newCompany, ...companies]));
    return { status: "inserted", company: newCompany as unknown as Record<string, unknown> };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_company_checked", {
    p_name: input.name, p_phone: input.phone, p_website_url: input.website_url || null, p_location: input.location,
    p_industry: input.industry || "", p_contact_name: input.contact_name || "", p_email: input.email || null,
    p_memo: input.memo || "", p_list_source: input.list_source || null,
    p_on_duplicate: onDuplicate,
  });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as CheckedWriteResult;
}

export interface BulkRowInput extends CompanyDraftInput { on_duplicate?: OnDuplicate }

export async function createCompaniesChecked(rows: BulkRowInput[], owner: string, defaultOnDuplicate: OnDuplicate = "skip"): Promise<CreateCompaniesCheckedResult> {
  if (!rows.length) return { results: [] };
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const blocklist = readBlocklist();
    const seenPhones = new Set<string>(), seenDomains = new Set<string>(), seenNameLocs = new Set<string>();
    const results: BulkRowResult[] = [];
    const toAdd: Company[] = [];
    let working = readLocal<Company[]>(COMPANY_KEY, demoCompanies);

    const markSeen = (k: { phone: string; domain: string; name: string; location: string }) => {
      if (k.phone) seenPhones.add(k.phone);
      if (k.domain) seenDomains.add(k.domain);
      if (k.name && k.location) seenNameLocs.add(`${k.name}|${k.location}`);
    };

    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const onDup = row.on_duplicate || defaultOnDuplicate;
      if (!VALID_ON_DUPLICATE.includes(onDup)) {
        results.push({ row: rowNum, status: "error", error_code: "invalid_on_duplicate" });
        return;
      }
      const keys = normalizeCompanyKeys(row);
      if (!keys.name) { results.push({ row: rowNum, status: "error", error_code: "name_required" }); return; }
      const withinCsv = (keys.phone && seenPhones.has(keys.phone)) || (keys.domain && seenDomains.has(keys.domain)) || (keys.name && keys.location && seenNameLocs.has(`${keys.name}|${keys.location}`));
      if (withinCsv) { results.push({ row: rowNum, status: "skipped", reason: "duplicate_within_csv" }); return; }

      const block = matchDemoBlocklist(blocklist, keys);
      if (block) {
        results.push({ row: rowNum, status: "blocked", blocklist_id: block.id, matched_scope: block.match_scope });
        markSeen(keys);
        return;
      }

      const dup = findDemoDuplicate([...working, ...toAdd], keys);
      if (dup && onDup === "skip") {
        results.push({ row: rowNum, status: "skipped", existing_company_id: dup.id });
        markSeen(keys);
        return;
      }
      if (dup && onDup === "update") {
        // 実効値（CSVが空欄なら既存値のまま）を合成してから禁止・重複を再判定する。
        // 空欄入力で既存の禁止一致キーを外して禁止判定を回避できないようにするため。
        const effective = {
          name: row.name || dup.name, phone: row.phone || dup.phone,
          website_url: row.website_url || dup.website_url, location: row.location || dup.location,
        };
        const effKeys = normalizeCompanyKeys(effective);
        const effBlock = matchDemoBlocklist(blocklist, effKeys);
        if (effBlock) {
          results.push({ row: rowNum, status: "blocked", blocklist_id: effBlock.id, matched_scope: effBlock.match_scope });
          markSeen(effKeys);
          return;
        }
        const conflicting = findDemoDuplicate([...working, ...toAdd], effKeys, dup.id);
        if (conflicting) {
          results.push({ row: rowNum, status: "skipped", reason: "duplicate_conflict", conflicting_company_id: conflicting.id });
          markSeen(effKeys);
          return;
        }
        working = working.map(c => c.id === dup.id ? {
          ...c, name: effective.name, phone: effective.phone, website_url: effective.website_url, location: effective.location,
          industry: row.industry || c.industry, contact_name: row.contact_name || c.contact_name,
          email: row.email || c.email, memo: row.memo || c.memo, list_source: row.list_source || c.list_source,
        } : c);
        results.push({ row: rowNum, status: "updated", company_id: dup.id });
        markSeen(effKeys);
        return;
      }

      const newCompany: Company = {
        id: crypto.randomUUID(), name: row.name, industry: row.industry || "", location: row.location, phone: row.phone,
        website_url: row.website_url || undefined, email: row.email || undefined, list_source: row.list_source,
        contact_name: row.contact_name || "", contact_department: "", heat: "低", owner_name: owner, memo: row.memo || "",
      };
      toAdd.push(newCompany);
      results.push({ row: rowNum, status: "inserted", company_id: newCompany.id });
      markSeen(keys);
    });

    localStorage.setItem(COMPANY_KEY, JSON.stringify([...toAdd, ...working]));
    return { results };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_companies_checked", {
    p_rows: rows.map(r => ({ name: r.name, phone: r.phone, website_url: r.website_url || null, location: r.location, industry: r.industry || "", contact_name: r.contact_name || "", email: r.email || null, memo: r.memo || "", list_source: r.list_source || null, on_duplicate: r.on_duplicate })),
    p_default_on_duplicate: defaultOnDuplicate,
  });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as CreateCompaniesCheckedResult;
}

export async function blockCompanyCalls(companyId: string, reason: string, matchScope: MatchScope = "strict"): Promise<BlocklistEntry> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const target = companies.find(c => c.id === companyId);
    if (!target) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    if (!reason.trim()) throw new Error(companySafetyErrorMessage("reason_required"));
    const keys = normalizeCompanyKeys(target);

    if (matchScope === "phone" && !keys.phone) throw new Error(companySafetyErrorMessage("phone_required_for_scope"));
    if (matchScope === "domain" && !keys.domain) throw new Error(companySafetyErrorMessage("domain_required_for_scope"));
    if (matchScope === "name_location" && (!keys.name || !keys.location)) throw new Error(companySafetyErrorMessage("name_and_location_required_for_scope"));
    if (matchScope === "name_only" && !keys.name) throw new Error(companySafetyErrorMessage("name_required_for_scope"));
    if (matchScope === "strict" && !keys.phone && !keys.domain && !(keys.name && keys.location)) throw new Error(companySafetyErrorMessage("identifier_required"));

    const list = readBlocklist();
    const existing = list.find(b => b.active && b.match_scope === matchScope && (
      (matchScope === "phone" && b.normalized_phone === keys.phone)
      || (matchScope === "domain" && b.normalized_domain === keys.domain)
      || (matchScope === "name_location" && b.normalized_name === keys.name && b.normalized_location === keys.location)
      || (matchScope === "name_only" && b.normalized_name === keys.name)
      || (matchScope === "strict" && (
        (Boolean(keys.phone) && b.normalized_phone === keys.phone)
        || (Boolean(keys.domain) && b.normalized_domain === keys.domain)
        || (Boolean(keys.name && keys.location) && b.normalized_name === keys.name && b.normalized_location === keys.location)
      ))
    ));
    const toEntry = (e: DemoBlockEntry): BlocklistEntry => ({
      id: e.id, organization_id: "", company_id: e.company_id, snapshot_name: target.name, snapshot_location: target.location,
      snapshot_phone: target.phone, snapshot_domain: target.website_url || null, match_scope: e.match_scope, reason: e.reason,
      note: "", active: e.active, created_by: "", created_at: e.created_at, updated_by: null, updated_at: e.created_at,
    });
    if (existing) return toEntry(existing);

    // 選択したscopeに必要な正規化キーだけを保存する（strictのみ、利用可能な強一致キーをすべて保存する）
    const entry: DemoBlockEntry = {
      id: crypto.randomUUID(), company_id: companyId,
      normalized_phone: (matchScope === "phone" || matchScope === "strict") ? (keys.phone || null) : null,
      normalized_domain: (matchScope === "domain" || matchScope === "strict") ? (keys.domain || null) : null,
      normalized_name: (matchScope === "name_location" || matchScope === "name_only" || matchScope === "strict") ? (keys.name || null) : null,
      normalized_location: (matchScope === "name_location" || matchScope === "strict") ? (keys.location || null) : null,
      match_scope: matchScope, reason: reason.trim(), active: true, created_at: new Date().toISOString(),
    };
    writeBlocklist([...list, entry]);
    return toEntry(entry);
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("block_company_calls", { p_company_id: companyId, p_phone: null, p_website_url: null, p_name: null, p_location: null, p_match_scope: matchScope, p_reason: reason });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as BlocklistEntry;
}

export async function unblockCompanyCalls(blocklistId: string, reason: string): Promise<BlocklistEntry> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    if (!reason.trim()) throw new Error(companySafetyErrorMessage("reason_required"));
    const list = readBlocklist();
    const target = list.find(b => b.id === blocklistId);
    if (!target) throw new Error(companySafetyErrorMessage("blocklist_entry_not_found"));
    // 既に解除済みでも技術エラーにせず、同じ行を安全に返す（冪等）
    if (!target.active) {
      return { id: target.id, organization_id: "", company_id: target.company_id, snapshot_name: null, snapshot_location: null, snapshot_phone: null, snapshot_domain: null, match_scope: target.match_scope, reason: target.reason, note: "", active: false, created_by: "", created_at: target.created_at, updated_by: null, updated_at: target.created_at };
    }
    writeBlocklist(list.map(b => b.id === blocklistId ? { ...b, active: false } : b));
    return { id: target.id, organization_id: "", company_id: target.company_id, snapshot_name: null, snapshot_location: null, snapshot_phone: null, snapshot_domain: null, match_scope: target.match_scope, reason: target.reason, note: "", active: false, created_by: "", created_at: target.created_at, updated_by: null, updated_at: new Date().toISOString() };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("unblock_company_calls", { p_blocklist_id: blocklistId, p_reason: reason });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as BlocklistEntry;
}

// ===========================================================
// 企業詳細・編集・アーカイブ管理
// ===========================================================

export interface CompanyUpdateInput {
  name?: string; phone?: string; website_url?: string; location?: string;
  industry?: string; contact_name?: string; contact_department?: string;
  email?: string; memo?: string; list_source?: string; source_url?: string;
  heat?: Heat; owner_id?: string | null; next_action_at?: string | null;
}

// update_company_checked()と同じ規約：キー自体が無ければ「変更しない」、
// キーが空文字列／nullなら「空欄にする」。呼び出し側（企業編集フォーム）は
// 変更するフィールドだけをpatchに含めること。
export async function updateCompanyChecked(companyId: string, patch: CompanyUpdateInput, onDuplicate: OnDuplicate = "skip"): Promise<CheckedWriteResult> {
  if (!VALID_ON_DUPLICATE.includes(onDuplicate)) throw new Error(companySafetyErrorMessage("invalid_on_duplicate"));
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const target = companies.find(c => c.id === companyId);
    if (!target) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    if (target.archived_at) throw new Error(companySafetyErrorMessage("company_is_archived"));

    const newName = (patch.name ?? "").trim() || target.name;
    const newPhone = (patch.phone ?? "").trim() || target.phone;
    const newWebsiteUrl = patch.website_url !== undefined ? patch.website_url : target.website_url;
    const newLocation = (patch.location ?? "").trim() || target.location;
    if (!newName.trim()) throw new Error(companySafetyErrorMessage("name_required"));

    if (patch.heat !== undefined && !["高", "中", "低"].includes(patch.heat)) {
      throw new Error(companySafetyErrorMessage("invalid_heat"));
    }

    let newOwnerId = target.owner_id;
    let newOwnerName = target.owner_name;
    if ("owner_id" in patch) {
      const ownerId = patch.owner_id || null;
      if (ownerId) {
        const members = readLocal<Member[]>(MEMBER_KEY, demoMembers);
        const ownerMember = members.find(m => m.id === ownerId && m.active);
        if (!ownerMember) throw new Error(companySafetyErrorMessage("owner_must_be_active_org_member"));
        newOwnerId = ownerId;
        newOwnerName = ownerMember.full_name;
      } else {
        newOwnerId = undefined;
        newOwnerName = "未割当";
      }
    }

    // 禁止判定用のドメインだけは、name/phone/locationと同じく「パッチが空欄なら既存値を
    // 維持」した値から算出する（禁止されていない企業が正当にURLを削除できるよう、
    // 書き込み値自体（newWebsiteUrl）は空欄を許すが、空欄化による禁止回避は防ぐ）。
    const blockCheckWebsiteUrl = patch.website_url ? patch.website_url : target.website_url;
    const blockCheckKeys = normalizeCompanyKeys({ name: newName, phone: newPhone, website_url: blockCheckWebsiteUrl, location: newLocation });
    const block = matchDemoBlocklist(readBlocklist(), blockCheckKeys);
    if (block) return { status: "blocked", blocklist_id: block.id, matched_scope: block.match_scope, reason: block.reason };

    const keys = normalizeCompanyKeys({ name: newName, phone: newPhone, website_url: newWebsiteUrl, location: newLocation });
    // アーカイブ済み企業は重複判定の対象から除外する（アーカイブによってそのキーは再利用可能になる）
    const activeOthers = companies.filter(c => c.id !== companyId && !c.archived_at);
    const dup = findDemoDuplicate(activeOthers, keys);
    if (dup && onDuplicate === "skip") return { status: "skipped", conflicting_company_id: dup.id };
    if (dup && onDuplicate !== "insert") return { status: "needs_explicit_resolution", conflicting_company_id: dup.id };

    const updated: Company = {
      ...target,
      name: newName, phone: newPhone, website_url: newWebsiteUrl || undefined, location: newLocation,
      industry: patch.industry !== undefined ? patch.industry : target.industry,
      contact_name: patch.contact_name !== undefined ? patch.contact_name : target.contact_name,
      contact_department: patch.contact_department !== undefined ? patch.contact_department : target.contact_department,
      email: patch.email !== undefined ? patch.email : target.email,
      memo: patch.memo !== undefined ? patch.memo : target.memo,
      list_source: patch.list_source !== undefined ? patch.list_source : target.list_source,
      source_url: patch.source_url !== undefined ? patch.source_url : target.source_url,
      heat: patch.heat !== undefined ? patch.heat : target.heat,
      owner_id: newOwnerId, owner_name: newOwnerName,
      next_action_at: "next_action_at" in patch ? (patch.next_action_at || undefined) : target.next_action_at,
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem(COMPANY_KEY, JSON.stringify(companies.map(c => c.id === companyId ? updated : c)));
    return { status: "updated", company: updated as unknown as Record<string, unknown> };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_company_checked", { p_company_id: companyId, p_patch: patch, p_on_duplicate: onDuplicate });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as CheckedWriteResult;
}

// 管理者専用（UI側で管理者以外にはボタン自体を表示しない。block_company_calls等の
// 既存の管理者専用アクションと同じ、デモモードでのUI側ゲーティング方針に合わせる）。
// ハードDELETEしない。call_logs・call_blocklistは一切変更しない。
export async function archiveCompany(companyId: string): Promise<ArchiveCompanyResult> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const target = companies.find(c => c.id === companyId);
    if (!target) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    if (target.archived_at) return { status: "already_archived", company: target as unknown as Record<string, unknown> };
    const updated: Company = { ...target, archived_at: new Date().toISOString() };
    localStorage.setItem(COMPANY_KEY, JSON.stringify(companies.map(c => c.id === companyId ? updated : c)));
    return { status: "archived", company: updated as unknown as Record<string, unknown> };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("archive_company", { p_company_id: companyId });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as ArchiveCompanyResult;
}

// 管理者専用。復元前に、現在有効な他企業との重複衝突を必ず確認する
// （衝突時はduplicate_conflictを返し、サイレントにマージしない）。
// 架電禁止（call_blocklist）状態は復元をブロックしない。
export async function restoreCompany(companyId: string): Promise<RestoreCompanyResult> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const target = companies.find(c => c.id === companyId);
    if (!target) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    if (!target.archived_at) return { status: "already_active", company: target as unknown as Record<string, unknown> };
    const keys = normalizeCompanyKeys(target);
    const activeOthers = companies.filter(c => c.id !== companyId && !c.archived_at);
    const dup = findDemoDuplicate(activeOthers, keys);
    if (dup) return { status: "duplicate_conflict", conflicting_company_id: dup.id };
    const updated: Company = { ...target, archived_at: null, archived_by: null };
    localStorage.setItem(COMPANY_KEY, JSON.stringify(companies.map(c => c.id === companyId ? updated : c)));
    return { status: "restored", company: updated as unknown as Record<string, unknown> };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("restore_company", { p_company_id: companyId });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as RestoreCompanyResult;
}

// 管理者専用（UI側で管理者以外にはチェックボックス・一括操作自体を表示しない）。
// ブラウザからarchive_company()を何十回も連続実行するのではなく、専用RPCで
// 1トランザクションにまとめる。空配列・上限件数はサーバー側（archive_companies）と
// 同じ規則をクライアント側でも先に検証し、無駄なラウンドトリップを避ける
// （最終的な安全性の担保はサーバー側のRPCが行う）。
export async function archiveCompanies(companyIds: string[]): Promise<BulkArchiveCompaniesResult> {
  const dedupIds = dedupeCompanyIds(companyIds);
  if (dedupIds.length === 0) throw new Error(companySafetyErrorMessage("company_ids_required"));
  if (dedupIds.length > MAX_BULK_ARCHIVE_IDS) throw new Error(companySafetyErrorMessage("too_many_company_ids"));

  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const companies = readLocal<Company[]>(COMPANY_KEY, demoCompanies);
    const targets = companies.filter(c => dedupIds.includes(c.id));
    if (targets.length !== dedupIds.length) throw new Error(companySafetyErrorMessage("company_not_found_in_your_organization"));
    const now = new Date().toISOString();
    let archivedCount = 0, alreadyArchivedCount = 0;
    const archivedIds: string[] = [];
    const updated = companies.map(c => {
      if (!dedupIds.includes(c.id)) return c;
      if (c.archived_at) { alreadyArchivedCount++; return c; }
      archivedCount++; archivedIds.push(c.id);
      return { ...c, archived_at: now };
    });
    localStorage.setItem(COMPANY_KEY, JSON.stringify(updated));
    return { status: "archived", requested_count: dedupIds.length, archived_count: archivedCount, already_archived_count: alreadyArchivedCount, archived_company_ids: archivedIds };
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("archive_companies", { p_company_ids: dedupIds });
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  return data as BulkArchiveCompaniesResult;
}

export interface CompanyCallLogPage {
  logs: CallLog[];
  hasMore: boolean;
}

export const COMPANY_CALL_LOG_PAGE_SIZE = 50;

// loadCRMData()のcall_logsは組織全体で最新500件に制限されているため、
// 特定企業の全履歴を見るにはこの専用クエリを使う（そのキャップの影響を受けない）。
// company_idで絞り込み、RLS（organization_id = current_organization_id()）により
// 他組織の行が混ざることはない。アーカイブ済み企業でも変わらず取得できる。
export async function loadCompanyCallLogs(companyId: string, offset = 0, limit: number = COMPANY_CALL_LOG_PAGE_SIZE): Promise<CompanyCallLogPage> {
  if (!isSupabaseConfigured) {
    if (!isDemoModeAllowed) throw new Error("本番環境のデータベース接続が未設定です");
    const all = readLocal<CallLog[]>(LOG_KEY, demoLogs)
      .filter(l => l.company_id === companyId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const page = all.slice(offset, offset + limit);
    return { logs: page, hasMore: offset + limit < all.length };
  }
  const supabase = createClient();
  const { data, error } = await supabase
    .from("call_logs")
    .select("*, companies(name), profiles!call_logs_caller_id_fkey(full_name)")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit); // limit+1件取得してhasMoreを判定する（count集計を避ける）
  if (error) throw new Error(companySafetyErrorMessage(error.message, error.code));
  const rows = data || [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const logs = pageRows.map((l: Record<string, unknown>) => ({
    ...l,
    company_name: (l.companies as { name?: string } | null)?.name || "削除済み",
    caller_name: (l.profiles as { full_name?: string } | null)?.full_name || "不明",
  })) as CallLog[];
  return { logs, hasMore };
}
