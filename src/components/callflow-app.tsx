"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronRight, ExternalLink, History, LayoutDashboard, LogOut, Menu, Phone, Plus, Search, Sparkles, Upload, Users, X } from "lucide-react";
import { loadCRMData, saveCallLog, saveCompaniesBulk, saveCompany, updateCompany, inviteMember, cancelInvitation, setMemberActive, setMemberRole } from "@/lib/data";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/client";
import type { CallLog, CallResult, Company, Heat, Member, MemberInvitation, MemberRole, TranscriptAnalysis } from "@/lib/types";
import {
  autoDetectMapping, buildCompanyUpdatePatch, buildErrorReportCsv, buildRows, decodeCsvFile, detectDelimiter, parseCsvText,
  rowToCompanyDraft, summarizeRows, CANONICAL_FIELD_LABELS, CANONICAL_FIELD_ORDER, DUPLICATE_TIER_LABELS,
} from "@/lib/csv-import";
import type { CanonicalField, ColumnMapping, CsvRowResult, DuplicateMode } from "@/lib/csv-import";
import {
  filterCompaniesByMember, filterLogsByMember, activeMemberOptions, buildMemberListRows, readStoredViewFilter, writeStoredViewFilter,
  resolveViewFilterMemberId, resolveCallIndex, computeTeamKpis,
} from "@/lib/members";
import type { MemberListRow } from "@/lib/members";

type View = "dashboard" | "call" | "companies" | "history" | "team";
const results: { value: CallResult; label: string }[] = [
  { value:"アポ獲得", label:"◎ アポ獲得" }, { value:"資料送付", label:"▣ 資料送付" },
  { value:"再架電", label:"↻ 再架電" }, { value:"担当者不在", label:"◷ 担当者不在" },
  { value:"見込みなし", label:"× 見込みなし" }, { value:"その他", label:"… その他" },
];
const meta: Record<View, [string,string]> = {
  dashboard:["ダッシュボード","今日の架電状況を確認できます"], call:["架電する","企業情報を確認しながら記録できます"],
  companies:["企業リスト","見込み顧客を検索・管理できます"], history:["架電履歴","チーム全体の活動履歴"], team:["メンバー・実績","担当者別の活動を確認できます"],
};
const fmt = (v?: string, time = false) => v ? new Intl.DateTimeFormat("ja-JP", { month:"numeric", day:"numeric", ...(time ? { hour:"2-digit", minute:"2-digit" } : {}) }).format(new Date(v)) : "未設定";
const badge = (result: string) => result === "アポ獲得" ? "bg-emerald-50 text-emerald-700" : result === "資料送付" ? "bg-purple-50 text-purple-700" : result === "見込みなし" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700";

export default function CallFlowApp() {
  const [view,setView] = useState<View>("dashboard");
  const [companies,setCompanies] = useState<Company[]>([]);
  const [logs,setLogs] = useState<CallLog[]>([]);
  const [loading,setLoading] = useState(true);
  const [callIndex,setCallIndex] = useState(0);
  // currentUserId/currentUserName は書き込み専用（架電記録・企業登録の担当者）。編集不可。
  const [currentUserId,setCurrentUserId] = useState("");
  const [currentUserName,setCurrentUserName] = useState("ログインユーザー");
  const [isAdmin,setIsAdmin] = useState(false);
  const [allMembers,setAllMembers] = useState<Member[]>([]);
  const [pendingInvitations,setPendingInvitations] = useState<MemberInvitation[]>([]);
  // viewFilterMemberId は表示・集計の絞り込み専用（なりすまし防止のため書き込みには使わない）
  const [viewFilterMemberId,setViewFilterMemberId] = useState<string>(()=>readStoredViewFilter());
  const [menu,setMenu] = useState(false);
  const [companyModal,setCompanyModal] = useState(false);
  const [importModal,setImportModal] = useState(false);
  const [csvModal,setCsvModal] = useState(false);
  const [aiModal,setAiModal] = useState(false);
  const [toast,setToast] = useState("");

  useEffect(()=>{writeStoredViewFilter(viewFilterMemberId)},[viewFilterMemberId]);

  const notify=(message:string)=>{setToast(message);setTimeout(()=>setToast(""),2600)};
  const applyData=(data:Awaited<ReturnType<typeof loadCRMData>>)=>{setCompanies(data.companies);setLogs(data.logs);setAllMembers(data.allMembers);setPendingInvitations(data.pendingInvitations);setCurrentUserId(data.currentUserId);setCurrentUserName(data.currentUser);setIsAdmin(data.isAdmin)};
  const refresh = async () => { try { applyData(await loadCRMData()); } catch(e) { notify(e instanceof Error?e.message:"データの取得に失敗しました"); } finally { setLoading(false); } };
  useEffect(()=>{let active=true;loadCRMData().then(data=>{if(active)applyData(data)}).catch(e=>{if(active)setToast(e instanceof Error?e.message:"データの取得に失敗しました")}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[]);
  const go=(next:View)=>{setView(next);setMenu(false)};
  const filteredCompanies=useMemo(()=>filterCompaniesByMember(companies,viewFilterMemberId),[companies,viewFilterMemberId]);
  const filteredLogs=useMemo(()=>filterLogsByMember(logs,viewFilterMemberId),[logs,viewFilterMemberId]);

  // 保存済みの担当者フィルターが、メンバー一覧の取得後に無効（存在しない／利用停止済み）と
  // 判明した場合は"all"へ戻す（Reactの「レンダー中に状態を調整する」パターン。
  // allMembers読み込み前の空配列で誤って"all"に戻さないようlength>0の間だけ判定する）。
  if(allMembers.length>0){
    const resolved=resolveViewFilterMemberId(viewFilterMemberId,activeMemberOptions(allMembers));
    if(resolved!==viewFilterMemberId)setViewFilterMemberId(resolved);
  }

  // 担当者フィルターが変わったら架電対象のインデックスを0へ戻す。
  // 件数が変わってcallIndexが範囲外になった場合も0へ補正する（同じくレンダー中に調整）。
  const [prevViewFilterMemberId,setPrevViewFilterMemberId]=useState(viewFilterMemberId);
  const filterChanged=viewFilterMemberId!==prevViewFilterMemberId;
  if(filterChanged)setPrevViewFilterMemberId(viewFilterMemberId);
  const resolvedCallIndex=resolveCallIndex({filterChanged,callIndex,filteredCompaniesLength:filteredCompanies.length});
  if(resolvedCallIndex!==callIndex)setCallIndex(resolvedCallIndex);

  const callCompany=(company:Company)=>{setCallIndex(Math.max(0,filteredCompanies.findIndex(c=>c.id===company.id)));go("call")};
  const logout=async()=>{if(isSupabaseConfigured)await createClient().auth.signOut();location.href="/login"};

  return <div className="min-h-screen bg-[#f5f7fb] text-[#172036]">
    <aside className={`fixed inset-y-0 left-0 z-40 w-[238px] bg-[#111a2e] px-[18px] py-6 text-white transition-transform lg:translate-x-0 ${menu?"translate-x-0":"-translate-x-full"}`}>
      <div className="mb-8 flex items-center gap-2.5 px-2 text-xl font-extrabold"><span className="grid size-8 place-items-center rounded-[9px] bg-gradient-to-br from-blue-400 to-violet-600 text-xs">CF</span><span>CallFlow<small className="block text-[8px] tracking-[1.7px] text-slate-500">TELESALES CRM</small></span></div>
      <Nav view={view} go={go}/>
      <div className="absolute bottom-5 left-[18px] right-[18px] border-t border-slate-700 pt-4">
        <div className="flex items-center gap-2.5"><div className="grid size-9 place-items-center rounded-full bg-blue-500 text-xs font-bold">{currentUserName.slice(0,1)}</div><div className="min-w-0 flex-1"><b className="block truncate text-xs">{currentUserName}</b><span className="text-[10px] text-slate-500">{isAdmin?"管理者":"一般メンバー"}</span></div><button onClick={logout} aria-label="ログアウト"><LogOut size={15} className="text-slate-500"/></button></div>
      </div>
    </aside>
    {menu&&<button className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" onClick={()=>setMenu(false)} aria-label="メニューを閉じる"/>}
    <main className="min-h-screen lg:ml-[238px]">
      <header className="flex min-h-[76px] items-center justify-between gap-3 px-4 md:px-8"><div className="flex items-center gap-3"><button className="lg:hidden" onClick={()=>setMenu(true)}><Menu/></button><div><h1 className="text-xl font-extrabold tracking-tight md:text-2xl">{meta[view][0]}</h1><p className="mt-1 hidden text-xs text-slate-500 sm:block">{meta[view][1]}</p></div></div><div className="flex gap-2"><select className="input hidden !w-auto md:block" value={viewFilterMemberId} onChange={e=>setViewFilterMemberId(e.target.value)} aria-label="担当者で絞り込み"><option value="all">全員</option>{activeMemberOptions(allMembers).map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select><button className="btn btn-ai" onClick={()=>setAiModal(true)}><Sparkles size={15}/><span className="hidden sm:inline">文字起こし解析</span></button></div></header>
      <div className="px-4 pb-10 md:px-8">{loading?<Loading/>:<>
        {view==="dashboard"&&<Dashboard companies={filteredCompanies} logs={filteredLogs} go={go}/>}
        {view==="companies"&&<Companies companies={filteredCompanies} callCompany={callCompany} add={()=>setCompanyModal(true)} bulkImport={()=>setImportModal(true)} csvImport={()=>setCsvModal(true)}/>}
        {view==="call"&&<CallScreen company={filteredCompanies[callIndex]} member={currentUserName} next={()=>setCallIndex(i=>filteredCompanies.length?(i+1)%filteredCompanies.length:0)} onSaved={refresh} notify={notify}/>}
        {view==="history"&&<HistoryView logs={filteredLogs}/>}
        {view==="team"&&<Team logs={filteredLogs} allMembers={allMembers} pendingInvitations={pendingInvitations} viewFilterMemberId={viewFilterMemberId} currentUserId={currentUserId} isAdmin={isAdmin} notify={notify} refresh={refresh}/>}
      </>}</div>
    </main>
    {companyModal&&<CompanyModal member={currentUserName} close={()=>setCompanyModal(false)} saved={async c=>{setCompanies(x=>[c,...x]);setCompanyModal(false);notify("企業を登録しました")}}/>}
    {importModal&&<LeadImportModal member={currentUserName} existing={companies} close={()=>setImportModal(false)} saved={async added=>{await refresh();setImportModal(false);notify(`${added}件の営業先を取り込みました`)}}/>}
    {csvModal&&<CsvImportModal member={currentUserName} existing={companies} close={()=>setCsvModal(false)} saved={async summary=>{await refresh();setCsvModal(false);notify(`新規${summary.newCount}件・更新${summary.updatedCount}件を登録しました（スキップ${summary.skippedCount}件・エラー${summary.errorCount}件）`)}}/>}
    {aiModal&&<TranscriptModal company={filteredCompanies[callIndex]} close={()=>setAiModal(false)} onApply={(a,transcript)=>{sessionStorage.setItem("callflow_analysis",JSON.stringify({...a,transcript}));setAiModal(false);go("call");notify("解析結果を架電記録へ反映しました")}}/>}
    {toast&&<div className="fixed bottom-6 right-6 z-[70] rounded-xl bg-[#152039] px-5 py-3 text-sm font-semibold text-white shadow-2xl">{toast}</div>}
    {!isSupabaseConfigured&&<div className="fixed bottom-3 left-3 z-20 rounded-full bg-amber-100 px-3 py-1 text-[10px] font-bold text-amber-800 lg:left-[250px]">デモモード</div>}
  </div>;
}

function Nav({view,go}:{view:View;go:(v:View)=>void}) { const items:[View,string,React.ReactNode][]=[["dashboard","ダッシュボード",<LayoutDashboard key="a"/>],["call","架電する",<Phone key="b"/>],["companies","企業リスト",<Building2 key="c"/>],["history","架電履歴",<History key="d"/>],["team","メンバー・実績",<Users key="e"/>]];return <nav><p className="mb-2 px-3 text-[9px] font-bold tracking-[1.5px] text-slate-600">メイン</p>{items.map(([id,label,icon],i)=><button key={id} onClick={()=>go(id)} className={`mb-1 flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[13px] ${view===id?"bg-[#1d2943] text-white":"text-slate-400 hover:bg-[#1d2943] hover:text-white"} ${i===4?"mt-6":""}`}>{<span className="[&>svg]:size-4">{icon}</span>}{label}</button>)}</nav> }
function Loading(){return <div className="grid min-h-[60vh] place-items-center"><div className="text-center"><div className="mx-auto mb-3 size-8 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600"/><p className="text-xs text-slate-500">データを読み込んでいます</p></div></div>}

function Dashboard({companies,logs,go}:{companies:Company[];logs:CallLog[];go:(v:View)=>void}) {
 const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"}).format(new Date()), todayLogs=logs.filter(l=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"}).format(new Date(l.created_at))===today);const calls=todayLogs.length||(isSupabaseConfigured?0:38),appt=todayLogs.filter(l=>l.result==="アポ獲得").length||(isSupabaseConfigured?0:3),materials=todayLogs.filter(l=>l.result==="資料送付").length||(isSupabaseConfigured?0:5),follow=companies.filter(c=>c.next_action_at).length;
 const kpis=[["本日の架電数",calls,"目標 50件"],["接続数",Math.max(1,Math.round(calls*.45)),"接続率 44.7%"],["アポ獲得",appt,"前日比 +1"],["資料送付",materials,"送付待ち 2件"],["要フォロー",follow,"期限順に表示"]];
 return <div className="fade-in"><div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{kpis.map(([l,v,s])=><div className="card p-4" key={l}><p className="text-[11px] font-bold text-slate-500">{l}</p><p className="my-1 text-[27px] font-extrabold">{v}</p><p className="text-[10px] text-emerald-600">{s}</p></div>)}</div><div className="mt-4 grid gap-4 xl:grid-cols-[1.55fr_1fr]"><div className="card"><CardHead title="直近7日間の活動" sub="チーム全体"/><div className="p-5"><ActivityChart logs={logs}/></div></div><div className="card"><CardHead title="フォロー予定" sub="すべて見る" click={()=>go("companies")}/><div className="p-4">{companies.filter(c=>c.next_action_at).slice(0,5).map(c=><div key={c.id} className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0"><div className="grid size-10 place-items-center rounded-lg bg-blue-50 text-[11px] font-extrabold text-blue-600">{fmt(c.next_action_at)}</div><div className="min-w-0 flex-1"><b className="block truncate text-xs">{c.name}</b><span className="text-[10px] text-slate-500">{fmt(c.next_action_at,true)}・{c.owner_name}</span></div><HeatBadge heat={c.heat}/></div>)}</div></div></div></div>
}
function ActivityChart({logs}:{logs:CallLog[]}){const formatter=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"});const data=Array.from({length:7},(_,i)=>{const date=new Date();date.setDate(date.getDate()-(6-i));const key=formatter.format(date),items=logs.filter(l=>formatter.format(new Date(l.created_at))===key);return [new Intl.DateTimeFormat("ja-JP",{weekday:"short",timeZone:"Asia/Tokyo"}).format(date),items.length,items.filter(l=>l.result!=="担当者不在").length] as const});const max=Math.max(1,...data.map(x=>x[1]));return <><div className="flex h-[215px] items-end gap-2 border-b border-slate-200 bg-[repeating-linear-gradient(to_top,#fff_0,#fff_42px,#f1f4f8_43px)] px-2">{data.map(([d,a,b],i)=><div className="relative flex h-full flex-1 items-end gap-1" key={`${d}-${i}`}><i className="flex-1 rounded-t bg-blue-600" style={{height:`${Math.max(a?5:0,a/max*185)}px`}}/><i className="flex-1 rounded-t bg-blue-200" style={{height:`${Math.max(b?5:0,b/max*185)}px`}}/><label className="absolute -bottom-6 w-full text-center text-[10px] text-slate-500">{d}</label></div>)}</div><p className="mt-8 text-[10px] text-slate-500"><i className="mr-1 inline-block size-2 rounded-full bg-blue-600"/>架電数 <i className="ml-3 mr-1 inline-block size-2 rounded-full bg-blue-200"/>接続数</p></>}
function CardHead({title,sub,click}:{title:string;sub?:string;click?:()=>void}){return <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><h2 className="text-sm font-extrabold">{title}</h2>{sub&&<button onClick={click} className={`text-[11px] ${click?"font-bold text-blue-600":"text-slate-500"}`}>{sub}</button>}</div>}

function Companies({companies,callCompany,add,bulkImport,csvImport}:{companies:Company[];callCompany:(c:Company)=>void;add:()=>void;bulkImport:()=>void;csvImport:()=>void}) { const [q,setQ]=useState("");const [heat,setHeat]=useState("");const [more,setMore]=useState(false);const filtered=companies.filter(c=>(c.name+c.contact_name+c.phone+(c.website_url||"")).toLowerCase().includes(q.toLowerCase())&&(!heat||c.heat===heat));return <div className="fade-in"><div className="mb-3 flex flex-wrap items-center gap-2"><div className="relative min-w-[240px] flex-1 md:max-w-sm"><Search className="absolute left-3 top-2.5 size-4 text-slate-400"/><input className="input pl-9" placeholder="企業名・担当者名・電話・URLで検索" value={q} onChange={e=>setQ(e.target.value)}/></div><select className="input !w-auto" value={heat} onChange={e=>setHeat(e.target.value)}><option value="">すべての温度感</option><option>高</option><option>中</option><option>低</option></select><button className="btn btn-primary" onClick={csvImport}><Upload size={15}/>CSV一括登録</button><div className="relative">{more&&<button className="fixed inset-0 z-10 cursor-default" onClick={()=>setMore(false)} aria-label="メニューを閉じる"/>}<button className="btn btn-light" onClick={()=>setMore(o=>!o)}>その他の登録方法 ▾</button>{more&&<div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-xl border border-slate-100 bg-white p-1.5 shadow-lg"><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50" onClick={()=>{setMore(false);add()}}><Plus size={14}/>企業を追加（手動）</button><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50" onClick={()=>{setMore(false);bulkImport()}}><Upload size={14}/>リスト自動取り込み（貼り付け）</button></div>}</div></div><div className="card overflow-x-auto"><table className="w-full min-w-[1040px] border-collapse"><thead><tr className="bg-slate-50 text-left text-[10px] text-slate-500">{["企業名","URL","業種","担当者","温度感","最終架電","次回対応","担当",""].map(x=><th className="border-b border-slate-200 px-4 py-3" key={x}>{x}</th>)}</tr></thead><tbody>{filtered.map(c=><tr key={c.id} className="text-xs hover:bg-slate-50"><td className="border-b border-slate-100 p-4"><b>{c.name}</b><small className="mt-1 block text-[10px] text-slate-500">{c.location} ／ {c.phone}</small></td><td className="border-b border-slate-100 p-4">{c.website_url?<a className="inline-flex items-center gap-1 font-bold text-blue-600" href={c.website_url} target="_blank" rel="noreferrer">確認<ExternalLink size={12}/></a>:<a className="text-slate-400 underline" href={searchUrl(c.name)} target="_blank" rel="noreferrer">検索</a>}</td><td className="border-b border-slate-100 p-4">{c.industry}</td><td className="border-b border-slate-100 p-4">{c.contact_department} {c.contact_name}</td><td className="border-b border-slate-100 p-4"><HeatBadge heat={c.heat}/></td><td className="border-b border-slate-100 p-4">{fmt(c.last_called_at)}</td><td className="border-b border-slate-100 p-4">{fmt(c.next_action_at,true)}</td><td className="border-b border-slate-100 p-4">{c.owner_name}</td><td className="border-b border-slate-100 p-4"><button className="font-bold text-blue-600" onClick={()=>callCompany(c)}>架電する</button></td></tr>)}</tbody></table>{!filtered.length&&<p className="p-16 text-center text-sm text-slate-500">該当する企業がありません</p>}</div></div> }
function HeatBadge({heat}:{heat:Heat}) {return <span className={`badge ${heat==="高"?"bg-red-50 text-red-600":heat==="中"?"bg-amber-50 text-amber-700":"bg-slate-100 text-slate-600"}`}>● {heat}</span>}

function CallScreen({company,member,next,onSaved,notify}:{company?:Company;member:string;next:()=>void;onSaved:()=>Promise<void>;notify:(s:string)=>void}) { const [staged]=useState<(TranscriptAnalysis&{transcript?:string})|null>(()=>{if(typeof window==="undefined")return null;const raw=sessionStorage.getItem("callflow_analysis");if(!raw)return null;sessionStorage.removeItem("callflow_analysis");try{return JSON.parse(raw) as TranscriptAnalysis&{transcript?:string}}catch{return null}});const [result,setResult]=useState<CallResult|"">(staged?.result||"");const [note,setNote]=useState(staged?`${staged.summary}\n次回対応：${staged.next_action}`:"");const [nextAt,setNextAt]=useState(staged?.next_action_at||"");const [saving,setSaving]=useState(false);if(!company)return <div className="card p-16 text-center text-slate-500">架電対象の企業がありません</div>;
 const save=async()=>{if(!result)return notify("架電結果を選択してください");setSaving(true);const created=new Date().toISOString(),updated={...company,heat:result==="アポ獲得"?"高" as Heat:company.heat,memo:note||company.memo,last_called_at:created,next_action_at:nextAt||undefined};const log:CallLog={id:crypto.randomUUID(),company_id:company.id,company_name:company.name,caller_name:member,result,note:note||"メモなし",transcript:staged?.transcript,ai_summary:staged?.summary,created_at:created,next_action_at:nextAt||undefined};try{await saveCallLog(log,updated);await onSaved();notify("架電記録を保存しました");setResult("");setNote("");setNextAt("");next()}catch(e){notify(e instanceof Error?e.message:"保存に失敗しました")}finally{setSaving(false)}};
 return <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]"><div className="card p-5"><div className="flex items-start justify-between gap-3"><div><HeatBadge heat={company.heat}/><h2 className="mt-2 text-2xl font-extrabold">{company.name}</h2><p className="mt-1 text-xs text-slate-500">{company.industry} ／ {company.location}</p><a href={`tel:${company.phone}`} className="mt-4 block text-xl font-extrabold text-blue-600">{company.phone}</a><div className="mt-3 flex flex-wrap gap-2">{company.website_url&&<a className="btn btn-light !py-2 text-xs" href={company.website_url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>公式URLを開く</a>}<a className="btn btn-light !py-2 text-xs" href={searchUrl(company.name)} target="_blank" rel="noreferrer"><Search size={14}/>会社名で検索</a>{company.source_url&&<a className="btn btn-light !py-2 text-xs" href={company.source_url} target="_blank" rel="noreferrer">取得元</a>}</div></div><button className="btn btn-light" onClick={next}>次の企業 <ChevronRight size={15}/></button></div><div className="my-5 grid grid-cols-2 gap-2"><Info l="担当者" v={`${company.contact_department||""} ${company.contact_name}`}/><Info l="過去の接触" v={company.last_called_at?`最終 ${fmt(company.last_called_at,true)}`:"接触履歴なし"}/><Info l="前回の内容" v={company.memo||"記録なし"}/><Info l="次回対応" v={fmt(company.next_action_at,true)}/></div><PreCallChecklist company={company}/><div className="mt-4 rounded-r-lg border-l-[3px] border-blue-600 bg-slate-50 p-4 text-xs leading-7"><b>受付：</b>お世話になります。OLTLの辻と申します。<br/><em className="font-bold not-italic text-blue-600">県内大学生との接点づくりに関する採用広報のご提案</em>で、新卒採用のご担当者様をお願いできますか？<br/><br/><b>担当者：</b>県内学生に御社を知ってもらうためのSNS採用広報について、事例を交えて15分ほどご紹介しています。</div></div><div className="card"><CardHead title="架電結果を記録" sub={`担当：${member}`}/><div className="p-5"><div className="mb-4 rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-blue-50 p-3"><b className="block text-xs text-violet-700">✦ appserver解析で自動入力できます</b><span className="text-[10px] text-slate-500">右上の「文字起こし解析」を利用してください。外部AI APIなしでもルール解析で動作します。</span></div><Label text="架電結果"><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">{results.map(r=><button key={r.value} onClick={()=>setResult(r.value)} className={`rounded-lg border p-2.5 text-[11px] ${result===r.value?"border-blue-500 bg-blue-50 font-bold text-blue-600":"border-slate-200 hover:border-blue-300"}`}>{r.label}</button>)}</div></Label><Label text="会話メモ"><textarea className="input min-h-24 resize-y" value={note} onChange={e=>setNote(e.target.value)} placeholder="相手の反応、課題、伝えた内容など"/></Label><Label text="次回対応日"><input type="datetime-local" className="input" value={nextAt} onChange={e=>setNextAt(e.target.value)}/></Label><div className="mt-4 flex gap-2"><button className="btn btn-light flex-1" onClick={next}>スキップ</button><button disabled={saving} className="btn btn-primary flex-1 disabled:opacity-50" onClick={save}>{saving?"保存中…":"記録して次へ"}</button></div></div></div></div> }
function Info({l,v}:{l:string;v:string}){return <div className="rounded-lg bg-slate-50 p-3"><small className="block text-[9px] text-slate-500">{l}</small><b className="mt-1 block text-xs">{v}</b></div>}
function Label({text,children}:{text:string;children:React.ReactNode}){return <label className="mb-4 block"><span className="mb-1.5 block text-[10px] font-bold text-slate-500">{text}</span>{children}</label>}

function searchUrl(name:string){return `https://www.google.com/search?q=${encodeURIComponent(`${name} 公式`)}`}
function normalizeUrl(url:string){if(!url)return "";return /^https?:\/\//i.test(url)?url:`https://${url}`}
function guessIndustry(text:string){const t=text.toLowerCase();if(/it|システム|saas|ソフト|開発/.test(t))return "IT・システム";if(/建設|工事|土木|設備/.test(t))return "建設・設備";if(/食品|飲食|製造|工場/.test(t))return "製造・食品";if(/病院|介護|福祉|医療/.test(t))return "医療・福祉";if(/ホテル|旅館|観光|宿泊/.test(t))return "観光・宿泊";return ""}
function parseLeadRows(raw:string, member:string, existing:Company[], defaults:{industry:string;location:string;source:string}) {
 const seen=new Set(existing.map(c=>`${c.name}|${c.phone}`));const phone=/0\d{1,4}[-(]?\d{1,4}[-)]?\d{3,4}/;const url=/(https?:\/\/[^\s,，\t]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,，\t]*)?)/i;
 return raw.split(/\n+/).map(line=>line.trim()).filter(Boolean).map(line=>{const cols=line.split(/\t|,|，/).map(c=>c.trim()).filter(Boolean);const joined=cols.join(" ");const phoneMatch=joined.match(phone)?.[0]||"";const urlMatch=joined.match(url)?.[0]||"";const name=(cols.find(c=>!phone.test(c)&&!url.test(c)&&/(株式会社|有限会社|合同会社|Inc\.|Co\.|会社|法人|医院|病院|工業|商事|建設|食品|テック|デザイン)/i.test(c))||cols.find(c=>!phone.test(c)&&!url.test(c))||"").replace(/^"+|"+$/g,"");if(!name||!phoneMatch)return null;const key=`${name}|${phoneMatch}`;if(seen.has(key))return null;seen.add(key);return {id:crypto.randomUUID(),name,phone:phoneMatch,website_url:normalizeUrl(urlMatch),source_url:normalizeUrl(defaults.source),list_source:defaults.source?"貼り付けリスト":"手動取り込み",industry:defaults.industry||guessIndustry(joined),location:defaults.location,contact_name:"",contact_department:"",heat:"低" as Heat,owner_name:member,memo:"自動取り込みで登録"} as Company}).filter((x):x is Company=>Boolean(x));
}
function PreCallChecklist({company}:{company:Company}){return <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4"><b className="block text-xs text-blue-700">架電前チェック</b><div className="mt-2 grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3"><span>1. 公式URLで事業内容を確認</span><span>2. 採用・ニュース欄を見る</span><span>3. 担当者名と前回メモを確認</span></div><p className="mt-2 text-[10px] text-slate-500">取得元：{company.list_source||"未設定"}{company.website_url?" ／ URL登録済み":" ／ 公式URL未登録"}</p></div>}

function HistoryView({logs}:{logs:CallLog[]}) {const [q,setQ]=useState("");const [f,setF]=useState("");const shown=logs.filter(l=>(l.company_name+l.note).toLowerCase().includes(q.toLowerCase())&&(!f||l.result===f));return <div><div className="mb-3 flex gap-2"><div className="relative flex-1 md:max-w-sm"><Search className="absolute left-3 top-2.5 size-4 text-slate-400"/><input className="input pl-9" value={q} onChange={e=>setQ(e.target.value)} placeholder="企業名・内容で検索"/></div><select className="input !w-auto" value={f} onChange={e=>setF(e.target.value)}><option value="">すべての結果</option>{results.slice(0,5).map(r=><option key={r.value}>{r.value}</option>)}</select></div><div className="card overflow-x-auto"><table className="w-full min-w-[850px]"><thead><tr className="bg-slate-50 text-left text-[10px] text-slate-500">{["日時","企業名","結果","担当","会話メモ・AI要約","次回対応"].map(x=><th key={x} className="border-b border-slate-200 p-3">{x}</th>)}</tr></thead><tbody>{shown.map(l=><tr className="text-xs" key={l.id}><td className="border-b border-slate-100 p-4">{fmt(l.created_at,true)}</td><td className="border-b border-slate-100 p-4 font-bold">{l.company_name}</td><td className="border-b border-slate-100 p-4"><span className={`badge ${badge(l.result)}`}>{l.result}</span></td><td className="border-b border-slate-100 p-4">{l.caller_name}</td><td className="max-w-[360px] border-b border-slate-100 p-4">{l.ai_summary||l.note}</td><td className="border-b border-slate-100 p-4">{fmt(l.next_action_at,true)}</td></tr>)}</tbody></table></div></div>}
function Team({logs,allMembers,pendingInvitations,viewFilterMemberId,currentUserId,isAdmin,notify,refresh}:{logs:CallLog[];allMembers:Member[];pendingInvitations:MemberInvitation[];viewFilterMemberId:string;currentUserId:string;isAdmin:boolean;notify:(s:string)=>void;refresh:()=>Promise<void>}) {
 // メンバー実績ランキングは「絞り込み」の対象（過去の実績は利用停止メンバーも保持するためallMembersを母集団にする）
 const rankedMembers=useMemo(()=>viewFilterMemberId==="all"?allMembers:allMembers.filter(m=>m.id===viewFilterMemberId),[allMembers,viewFilterMemberId]);
 const data=useMemo(()=>rankedMembers.map(m=>{const own=logs.filter(l=>l.caller_id===m.id);return {id:m.id,name:m.full_name,active:m.active,calls:own.length,appt:own.filter(l=>l.result==="アポ獲得").length}}).sort((a,b)=>b.calls-a.calls),[rankedMembers,logs]);
 // logsは呼び出し元（CallFlowApp）で担当者フィルター済み。"全員"ならチーム全体、
 // 特定担当者ならその人だけの数値になる
 const kpis=useMemo(()=>computeTeamKpis(logs),[logs]);
 const [inviteModal,setInviteModal]=useState(false);
 return <div>
  <div className="grid grid-cols-2 gap-3 md:grid-cols-3"><Kpi l="チーム架電数" v={kpis.totalCalls}/><Kpi l="チームアポ数" v={kpis.totalAppointments}/><Kpi l="平均接続率" v={`${kpis.connectionRate}%`}/></div>
  <div className="card mt-4"><CardHead title="メンバー実績" sub="直近500件"/><div className="p-5">{data.map((r,i)=><div key={r.id} className="grid grid-cols-[30px_1fr_65px_65px] items-center gap-3 border-b border-slate-100 py-3 last:border-0"><b className={i===0?"text-amber-500":"text-slate-400"}>{i+1}</b><div><b className="text-xs">{r.name}{!r.active&&<span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">利用停止</span>}</b><div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-100"><i className="block h-full rounded bg-blue-600" style={{width:`${Math.max(8,r.calls/Math.max(1,data[0]?.calls||1)*100)}%`}}/></div></div><p className="text-right text-sm font-bold">{r.calls}<small className="block text-[9px] font-normal text-slate-500">架電</small></p><p className="text-right text-sm font-bold">{r.appt}<small className="block text-[9px] font-normal text-slate-500">アポ</small></p></div>)}{!data.length&&<p className="p-8 text-center text-xs text-slate-500">該当するメンバーがいません</p>}</div></div>
  {isAdmin&&<div className="card mt-4">
   <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><h2 className="text-sm font-extrabold">メンバー管理</h2><button className="btn btn-primary !py-1.5 text-xs" onClick={()=>setInviteModal(true)}><Plus size={14}/>メンバーを追加</button></div>
   <MemberManagementList allMembers={allMembers} pendingInvitations={pendingInvitations} currentUserId={currentUserId} notify={notify} refresh={refresh}/>
  </div>}
  {inviteModal&&<InviteMemberModal close={()=>setInviteModal(false)} saved={async()=>{await refresh();setInviteModal(false);notify("招待を作成しました。対象者がGoogleで初回ログインすると参加します")}} notify={notify}/>}
 </div>
}

function MemberManagementList({allMembers,pendingInvitations,currentUserId,notify,refresh}:{allMembers:Member[];pendingInvitations:MemberInvitation[];currentUserId:string;notify:(s:string)=>void;refresh:()=>Promise<void>}) {
 const rows=useMemo(()=>buildMemberListRows(allMembers,pendingInvitations),[allMembers,pendingInvitations]);
 const [busyId,setBusyId]=useState("");
 const statusLabel=(s:MemberListRow["status"])=>s==="invited"?"初回ログイン待ち":s==="active"?"有効":"利用停止";
 const statusTone=(s:MemberListRow["status"])=>s==="invited"?"bg-amber-50 text-amber-700":s==="active"?"bg-emerald-50 text-emerald-700":"bg-slate-100 text-slate-600";
 const run=async(id:string,action:()=>Promise<unknown>,successMessage:string)=>{setBusyId(id);try{await action();await refresh();notify(successMessage)}catch(e){notify(e instanceof Error?e.message:"操作に失敗しました")}finally{setBusyId("")}};
 return <div className="p-2">
  {rows.map(r=><div key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3 text-xs last:border-0">
   <div className="min-w-[160px] flex-1"><b className="block">{r.full_name}</b><span className="text-[10px] text-slate-500">{r.email||"—"}</span></div>
   <span className="badge bg-slate-100 text-slate-600">{r.role==="admin"?"管理者":"一般メンバー"}</span>
   <span className={`badge ${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
   <span className="w-24 text-[10px] text-slate-400">{r.created_at?fmt(r.created_at):""}</span>
   <div className="flex flex-wrap gap-1.5">
    {r.kind==="invitation"&&<button disabled={busyId===r.id} className="btn btn-light !py-1 text-[11px]" onClick={()=>run(r.id,()=>cancelInvitation(r.id),"招待を取り消しました")}>招待キャンセル</button>}
    {r.kind==="member"&&r.id!==currentUserId&&<>
     {r.status==="active"
      ?<button disabled={busyId===r.id} className="btn btn-light !py-1 text-[11px]" onClick={()=>run(r.id,()=>setMemberActive(r.id,false,currentUserId),"利用停止にしました")}>利用停止</button>
      :<button disabled={busyId===r.id} className="btn btn-light !py-1 text-[11px]" onClick={()=>run(r.id,()=>setMemberActive(r.id,true,currentUserId),"再有効化しました")}>再有効化</button>}
     <button disabled={busyId===r.id} className="btn btn-light !py-1 text-[11px]" onClick={()=>run(r.id,()=>setMemberRole(r.id,r.role==="admin"?"member":"admin",currentUserId),"権限を変更しました")}>{r.role==="admin"?"一般メンバーにする":"管理者にする"}</button>
    </>}
    {r.kind==="member"&&r.id===currentUserId&&<span className="text-[10px] text-slate-400">自分自身は変更できません</span>}
   </div>
  </div>)}
  {!rows.length&&<p className="p-8 text-center text-xs text-slate-500">メンバーがいません</p>}
 </div>
}

function InviteMemberModal({close,saved,notify}:{close:()=>void;saved:()=>void;notify:(s:string)=>void}) {
 const [email,setEmail]=useState("");const [fullName,setFullName]=useState("");const [role,setRole]=useState<MemberRole>("member");const [busy,setBusy]=useState(false);
 const submit=async()=>{if(!email.trim()||!fullName.trim())return;setBusy(true);try{await inviteMember(email,fullName,role);saved()}catch(e){notify(e instanceof Error?e.message:"招待の作成に失敗しました")}finally{setBusy(false)}};
 return <Modal title="メンバーを追加" sub="対象者がこのメールアドレスのGoogleアカウントで初回ログインすると、自動的に組織へ参加します" close={close}>
  <Field l="氏名" v={fullName} set={setFullName}/>
  <Field l="メールアドレス" v={email} set={setEmail}/>
  <Label text="権限"><select className="input" value={role} onChange={e=>setRole(e.target.value as MemberRole)}><option value="member">一般メンバー</option><option value="admin">管理者</option></select></Label>
  <button disabled={busy||!email.trim()||!fullName.trim()} onClick={submit} className="btn btn-primary w-full disabled:opacity-50">{busy?"招待を作成中…":"招待を作成する"}</button>
 </Modal>
}
function Kpi({l,v}:{l:string;v:string|number}){return <div className="card p-4"><small className="font-bold text-slate-500">{l}</small><p className="mt-2 text-3xl font-extrabold">{v}</p></div>}

function Modal({title,sub,close,children}:{title:string;sub?:string;close:()=>void;children:React.ReactNode}) {return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-3" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="max-h-[94vh] w-full max-w-[680px] overflow-auto rounded-2xl bg-white shadow-2xl"><div className="flex items-start justify-between border-b border-slate-100 p-5"><div><h2 className="font-extrabold">{title}</h2>{sub&&<p className="mt-1 text-[10px] text-slate-500">{sub}</p>}</div><button onClick={close}><X className="size-5 text-slate-400"/></button></div><div className="p-5">{children}</div></div></div>}
function LeadImportModal({member,existing,close,saved}:{member:string;existing:Company[];close:()=>void;saved:(added:number)=>void}) {const [raw,setRaw]=useState("株式会社サンプル商事,076-000-0000,https://example.com\n石川採用テック 076-111-2222 www.example.jp");const [defaults,setDefaults]=useState({industry:"",location:"石川県",source:""});const [busy,setBusy]=useState(false);const leads=useMemo(()=>parseLeadRows(raw,member,existing,defaults),[raw,member,existing,defaults]);const submit=async()=>{if(!leads.length)return;setBusy(true);try{for(const lead of leads)await saveCompany(lead);saved(leads.length)}finally{setBusy(false)}};return <Modal title="営業先リストを自動取り込み" sub="CSV・表・Webページからコピーしたテキストを貼ると、会社名・電話番号・URLを抽出します" close={close}><div className="grid gap-3 sm:grid-cols-3"><Field l="既定の業種" v={defaults.industry} set={v=>setDefaults(d=>({...d,industry:v}))}/><Field l="既定の所在地" v={defaults.location} set={v=>setDefaults(d=>({...d,location:v}))}/><Field l="取得元URL" v={defaults.source} set={v=>setDefaults(d=>({...d,source:v}))}/></div><Label text="リスト貼り付け"><textarea className="input min-h-[180px] resize-y font-mono text-xs" value={raw} onChange={e=>setRaw(e.target.value)} placeholder="会社名, 電話番号, URL の順でなくてもOKです"/></Label><div className="mb-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><b className="block text-slate-800">取り込み候補：{leads.length}件</b><p className="mt-1 text-[10px]">既存の企業名＋電話番号と重複する行、会社名か電話番号が取れない行は除外します。</p></div>{leads.length>0&&<div className="mb-4 max-h-44 overflow-auto rounded-xl border border-slate-100"><table className="w-full text-left text-[11px]"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">企業名</th><th className="p-2">電話</th><th className="p-2">URL</th></tr></thead><tbody>{leads.slice(0,20).map(l=><tr key={l.id}><td className="border-t border-slate-100 p-2 font-bold">{l.name}</td><td className="border-t border-slate-100 p-2">{l.phone}</td><td className="border-t border-slate-100 p-2">{l.website_url||"未検出"}</td></tr>)}</tbody></table></div>}<button disabled={busy||!leads.length} onClick={submit} className="btn btn-primary w-full disabled:opacity-50">{busy?"取り込み中…":`${leads.length}件を登録する`}</button></Modal>}
function ResultStat({label,value,tone}:{label:string;value:number;tone:"slate"|"emerald"|"amber"|"red"|"blue"}) { const cls={slate:"bg-slate-50 text-slate-600",emerald:"bg-emerald-50 text-emerald-700",amber:"bg-amber-50 text-amber-700",red:"bg-red-50 text-red-600",blue:"bg-blue-50 text-blue-700"}[tone]; return <div className={`rounded-xl p-3 ${cls}`}><p className="text-[10px] font-bold">{label}</p><p className="mt-1 text-xl font-extrabold">{value}</p></div> }
function shortWarningLabel(w:string):string { if(w.includes("企業名が一致する既存データ"))return "同名企業があります"; if(w.includes("メールアドレスの形式"))return "メール形式を確認してください"; if(w.includes("URLの形式"))return "URL形式を確認してください"; return w }

function CsvImportModal({member,existing,close,saved}:{member:string;existing:Company[];close:()=>void;saved:(s:{newCount:number;updatedCount:number;skippedCount:number;errorCount:number})=>void}) {
 const [fileName,setFileName]=useState("");
 const [headers,setHeaders]=useState<string[]>([]);
 const [dataRows,setDataRows]=useState<string[][]>([]);
 const [mapping,setMapping]=useState<ColumnMapping>({});
 const [listSource,setListSource]=useState("");
 const [duplicateMode,setDuplicateMode]=useState<DuplicateMode>("skip");
 const [parseError,setParseError]=useState("");
 const [dragOver,setDragOver]=useState(false);
 const [parsing,setParsing]=useState(false);
 const [busy,setBusy]=useState(false);
 const [result,setResult]=useState<{newCount:number;updatedCount:number;skippedCount:number;errorCount:number;errorRows:CsvRowResult[]}|null>(null);
 const submittingRef=useRef(false); // busyのstate反映が間に合わない連打でも二重登録しないための同期ガード

 const rows=useMemo(()=>headers.length?buildRows(dataRows,mapping,existing):[],[headers,dataRows,mapping,existing]);
 const summary=useMemo(()=>headers.length?summarizeRows(headers,mapping,rows):null,[headers,mapping,rows]);

 const resolveAction=useCallback((row:CsvRowResult):"insert"|"update"|"skip"=>{
  if(!row.duplicate)return "insert";
  if(duplicateMode==="insert")return "insert";
  if(duplicateMode==="skip")return "skip";
  return row.duplicate.matchedExisting?"update":"skip"; // CSV内のみの重複は更新先が無いためスキップ扱い
 },[duplicateMode]);
 const actionableCount=useMemo(()=>rows.filter(r=>!r.errors.length&&resolveAction(r)!=="skip").length,[rows,resolveAction]);

 const handleFile=async(file:File)=>{
  setParseError("");setResult(null);setParsing(true);
  try{
   const text=await decodeCsvFile(file);
   const table=parseCsvText(text,detectDelimiter(text));
   if(!table.length){setParseError("CSVの内容を読み取れませんでした");return}
   const [head,...body]=table;
   setFileName(file.name);setHeaders(head);setDataRows(body);setMapping(autoDetectMapping(head));
  }catch{setParseError("ファイルの読み込みに失敗しました。文字コードや形式をご確認ください")}
  finally{setParsing(false)}
 };
 const onInputChange=(e:React.ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];if(f)handleFile(f)};
 const onDrop=(e:React.DragEvent)=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files?.[0];if(f)handleFile(f)};

 const submit=async()=>{
  if(!summary||!summary.validCount)return;
  if(submittingRef.current)return;
  submittingRef.current=true;
  setBusy(true);
  try{
   const eligible=rows.filter(r=>!r.errors.length);
   const toInsert=eligible.filter(r=>resolveAction(r)==="insert");
   const toUpdate=eligible.filter(r=>resolveAction(r)==="update");
   const skippedCount=eligible.filter(r=>resolveAction(r)==="skip").length;

   const drafts=toInsert.map(r=>rowToCompanyDraft(r,member,listSource));
   const {saved:insertedOk,errors:insertErrors}=drafts.length?await saveCompaniesBulk(drafts):{saved:[],errors:[]};

   const updateErrors:{index:number;message:string}[]=[];
   let updatedOk=0;
   for(const row of toUpdate){
    const target=row.duplicate!.matchedExisting!;
    try{
     await updateCompany(target.id,buildCompanyUpdatePatch(row,target,listSource));
     updatedOk++;
    }catch(e){updateErrors.push({index:row.rowIndex,message:e instanceof Error?e.message:"更新に失敗しました"})}
   }

   const errorRows=[
    ...rows.filter(r=>r.errors.length),
    ...insertErrors.map(er=>({...toInsert[er.index],errors:[er.message]} as CsvRowResult)),
    ...updateErrors.map(er=>({...toUpdate.find(r=>r.rowIndex===er.index)!,errors:[er.message]} as CsvRowResult)),
   ];
   setResult({newCount:insertedOk.length,updatedCount:updatedOk,skippedCount,errorCount:errorRows.length,errorRows});
  }finally{setBusy(false);submittingRef.current=false}
 };

 const downloadErrors=()=>{
  if(!result?.errorRows.length)return;
  const csv=buildErrorReportCsv(result.errorRows);
  const blob=new Blob([`﻿${csv}`],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download="csv一括登録_エラー一覧.csv";a.click();URL.revokeObjectURL(url);
 };

 if(result){
  return <Modal title="CSV一括登録の結果" close={()=>saved(result)}>
   <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <ResultStat label="新規登録" value={result.newCount} tone="emerald"/>
    <ResultStat label="更新" value={result.updatedCount} tone="blue"/>
    <ResultStat label="重複スキップ" value={result.skippedCount} tone="amber"/>
    <ResultStat label="エラー" value={result.errorCount} tone="red"/>
   </div>
   {result.errorRows.length>0&&<div className="mt-4">
    <div className="mb-2 flex items-center justify-between"><b className="text-xs">エラー行と理由</b><button className="text-[11px] font-bold text-blue-600" onClick={downloadErrors}>エラー一覧をCSVでダウンロード</button></div>
    <div className="max-h-52 overflow-auto rounded-xl border border-slate-100"><table className="w-full text-left text-[11px]"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">企業名</th><th className="p-2">理由</th></tr></thead><tbody>{result.errorRows.map((r,i)=><tr key={i}><td className="border-t border-slate-100 p-2 font-bold">{r.name||"(空欄)"}</td><td className="border-t border-slate-100 p-2 text-red-600">{r.errors.join(" / ")}</td></tr>)}</tbody></table></div>
   </div>}
   <button className="btn btn-primary mt-4 w-full" onClick={()=>saved(result)}>閉じる</button>
  </Modal>;
 }

 return <Modal title="CSV一括登録" sub="営業先リストのCSVファイルを選び、内容を確認してから一括登録します" close={close}>
  <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={onDrop} className={`mb-4 rounded-xl border-2 border-dashed p-6 text-center text-xs ${dragOver?"border-blue-400 bg-blue-50":"border-slate-200"}`}>
   <p className="mb-2 text-slate-600">{parsing?"解析中…":(fileName||"CSVファイルをドラッグ＆ドロップ、または選択してください")}</p>
   <label className={`btn btn-light mx-auto inline-flex w-fit cursor-pointer ${parsing?"pointer-events-none opacity-50":""}`}><Upload size={14}/>ファイルを選択<input type="file" accept=".csv,text/csv" className="hidden" onChange={onInputChange} disabled={parsing}/></label>
  </div>
  {parseError&&<p className="mb-4 rounded-lg bg-red-50 p-3 text-xs text-red-600">{parseError}</p>}

  {headers.length>0&&<>
   <div className="mb-4"><Field l="リスト名／キャンペーン名（任意・全行に適用）" v={listSource} set={setListSource}/></div>

   <Label text="列の割り当て"><div className="grid gap-2 sm:grid-cols-2">{headers.map((h,idx)=><div key={idx} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-[11px]"><span className="flex-1 truncate font-bold">{h||`列${idx+1}`}</span><select className="input !w-auto !py-1 text-[11px]" value={mapping[idx]||""} onChange={e=>setMapping(m=>({...m,[idx]:e.target.value as CanonicalField|""}))}><option value="">使用しない</option>{CANONICAL_FIELD_ORDER.map(f=><option key={f} value={f}>{CANONICAL_FIELD_LABELS[f]}</option>)}</select></div>)}</div></Label>

   {summary&&<div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
    <ResultStat label="総件数" value={summary.total} tone="slate"/>
    <ResultStat label="登録可能" value={summary.validCount} tone="emerald"/>
    <ResultStat label="必須項目不足" value={summary.missingRequiredCount} tone="red"/>
    <ResultStat label="重複候補" value={summary.duplicateCount} tone="amber"/>
   </div>}

   <Label text="重複候補への対応（初期値：スキップ）"><div className="flex flex-wrap gap-2">{(["skip","update","insert"] as DuplicateMode[]).map(m=><button key={m} onClick={()=>setDuplicateMode(m)} className={`rounded-lg border px-3 py-2 text-[11px] ${duplicateMode===m?"border-blue-500 bg-blue-50 font-bold text-blue-600":"border-slate-200"}`}>{m==="skip"?"重複候補をスキップ":m==="update"?"既存情報を更新":"重複でも新規登録"}</button>)}</div></Label>

   {summary&&summary.previewRows.length>0&&<div className="mb-4 max-h-56 overflow-auto rounded-xl border border-slate-100"><table className="w-full text-left text-[11px]"><thead className="bg-slate-50 text-slate-500"><tr>{["企業名","電話","URL","所在地","状態"].map(x=><th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{summary.previewRows.map((r,i)=><tr key={i}><td className="border-t border-slate-100 p-2 font-bold">{r.name||"(空欄)"}</td><td className="border-t border-slate-100 p-2">{r.phone||"—"}</td><td className="border-t border-slate-100 p-2">{r.website_url||"—"}</td><td className="border-t border-slate-100 p-2">{r.location||"—"}</td><td className="border-t border-slate-100 p-2">{r.errors.length?<span className="text-red-600">{r.errors[0]}</span>:r.duplicate?<span className="text-amber-600">重複候補（{DUPLICATE_TIER_LABELS[r.duplicate.tier]}）</span>:r.warnings.length?<span className="text-amber-600">注意：{r.warnings.map(shortWarningLabel).join("／")}</span>:<span className="text-emerald-600">登録可能</span>}</td></tr>)}</tbody></table></div>}

   <button disabled={busy||parsing||!actionableCount} onClick={submit} className="btn btn-primary w-full disabled:opacity-50">{busy?"登録中…":parsing?"解析中…":`${actionableCount}件を登録する`}</button>
  </>}
 </Modal>;
}

function CompanyModal({member,close,saved}:{member:string;close:()=>void;saved:(c:Company)=>void}) {const [form,setForm]=useState({name:"",phone:"",website_url:"",source_url:"",industry:"",location:"石川県",contact_name:"",contact_department:"",heat:"低" as Heat,memo:""});const [busy,setBusy]=useState(false);const change=(k:string,v:string)=>setForm(f=>({...f,[k]:v}));const submit=async()=>{if(!form.name||!form.phone)return;setBusy(true);try{const c=await saveCompany({id:crypto.randomUUID(),...form,website_url:normalizeUrl(form.website_url),source_url:normalizeUrl(form.source_url),owner_name:member});saved(c)}finally{setBusy(false)}};return <Modal title="企業を追加" close={close}><div className="grid gap-3 sm:grid-cols-2"><Field l="企業名 *" v={form.name} set={v=>change("name",v)}/><Field l="電話番号 *" v={form.phone} set={v=>change("phone",v)}/><Field l="公式URL" v={form.website_url} set={v=>change("website_url",v)}/><Field l="取得元URL" v={form.source_url} set={v=>change("source_url",v)}/><Field l="業種" v={form.industry} set={v=>change("industry",v)}/><Field l="所在地" v={form.location} set={v=>change("location",v)}/><Field l="担当者名" v={form.contact_name} set={v=>change("contact_name",v)}/><Field l="部署・役職" v={form.contact_department} set={v=>change("contact_department",v)}/><Label text="温度感"><select className="input" value={form.heat} onChange={e=>change("heat",e.target.value)}><option>低</option><option>中</option><option>高</option></select></Label><div className="sm:col-span-2"><Label text="メモ"><textarea className="input min-h-20" value={form.memo} onChange={e=>change("memo",e.target.value)}/></Label></div></div><button disabled={busy||!form.name||!form.phone} onClick={submit} className="btn btn-primary w-full disabled:opacity-50">{busy?"登録中…":"企業を登録する"}</button></Modal>}
function Field({l,v,set}:{l:string;v:string;set:(v:string)=>void}){return <Label text={l}><input className="input" value={v} onChange={e=>set(e.target.value)}/></Label>}
function TranscriptModal({company,close,onApply}:{company?:Company;close:()=>void;onApply:(a:TranscriptAnalysis,transcript:string)=>void}) {const [text,setText]=useState("");const [analysis,setAnalysis]=useState<TranscriptAnalysis|null>(null);const [busy,setBusy]=useState(false);const run=async()=>{if(text.trim().length<15)return;setBusy(true);try{const res=await fetch("/api/analyze-transcript",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({transcript:text,company_name:company?.name})});if(!res.ok)throw new Error("解析できませんでした");setAnalysis(await res.json())}finally{setBusy(false)}};return <Modal title="✦ 通話文字起こし解析" sub="外部AI APIなしでもappserver内のルール解析で、結果・要約・次回対応を整理します" close={close}><Label text="文字起こし"><textarea className="input min-h-[190px]" value={text} onChange={e=>setText(e.target.value)} placeholder="お世話になります、OLTLの辻と申します。採用広報の件で…"/></Label><button disabled={busy||text.length<15} onClick={run} className="btn btn-ai w-full disabled:opacity-50"><Sparkles size={15}/>{busy?"解析中…":"appserverで解析する"}</button>{analysis&&<div className="mt-4 border-t border-slate-100 pt-4"><div className="grid grid-cols-2 gap-2"><Analysis l="架電結果" v={analysis.result}/><Analysis l="温度感" v={analysis.heat}/><Analysis l="次回対応" v={analysis.next_action}/><Analysis l="検出した担当者" v={analysis.contact_name||"検出できず"}/></div><div className="mt-2 rounded-lg bg-violet-50 p-3 text-xs leading-6"><b className="block text-violet-700">解析要約</b>{analysis.summary}</div><p className="mt-2 text-right text-[9px] text-slate-400">解析信頼度 {Math.round(analysis.confidence*100)}%</p><button className="btn btn-primary mt-3 w-full" onClick={()=>onApply(analysis,text)}>架電記録に反映する</button></div>}</Modal>}
function Analysis({l,v}:{l:string;v:string}){return <div className="rounded-lg bg-slate-50 p-3"><small className="block text-[9px] text-slate-500">{l}</small><b className="mt-1 block text-xs">{v}</b></div>}
