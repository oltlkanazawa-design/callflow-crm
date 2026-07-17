import type { CallLog, Company, Member } from "./types";

export const demoMembers: Member[] = [
  { id:"m-tsuji", full_name:"辻 保", email:"tsuji@example.com", role:"admin", active:true },
  { id:"m-yamada", full_name:"山田 花子", email:"yamada@example.com", role:"member", active:true },
  { id:"m-sato", full_name:"佐藤 健", email:"sato@example.com", role:"member", active:true },
  { id:"m-takahashi", full_name:"高橋 美咲", email:"takahashi@example.com", role:"member", active:true },
];

export const demoCompanies: Company[] = [
  { id:"c1", name:"株式会社北陸テック", industry:"IT・システム開発", location:"石川県金沢市", phone:"076-123-4567", website_url:"https://example.com/hokuriku-tech", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"山本様", contact_department:"人事部", heat:"中", owner_id:"m-tsuji", owner_name:"辻 保", memo:"採用SNSに興味あり。繁忙時間を避ける", last_called_at:"2026-07-10T15:20:00+09:00", next_action_at:"2026-07-14T16:00:00+09:00" },
  { id:"c2", name:"金沢フーズ株式会社", industry:"食品製造", location:"石川県白山市", phone:"076-248-8100", website_url:"https://example.com/kanazawa-foods", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"中田様", contact_department:"総務部", heat:"高", owner_id:"m-yamada", owner_name:"山田 花子", memo:"若手採用に課題。事例資料を希望", last_called_at:"2026-07-14T15:18:00+09:00", next_action_at:"2026-07-16T10:00:00+09:00" },
  { id:"c3", name:"株式会社加賀建設", industry:"建設・土木", location:"石川県小松市", phone:"0761-22-9081", website_url:"https://example.com/kaga-kensetsu", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"前田様", contact_department:"採用担当", heat:"中", owner_id:"m-sato", owner_name:"佐藤 健", memo:"社長確認後に再連絡", last_called_at:"2026-07-11T10:05:00+09:00", next_action_at:"2026-07-15T10:00:00+09:00" },
  { id:"c4", name:"能登観光開発株式会社", industry:"観光・宿泊", location:"石川県七尾市", phone:"0767-53-1122", website_url:"https://example.com/noto-tourism", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"田村様", contact_department:"支配人", heat:"低", owner_id:"m-takahashi", owner_name:"高橋 美咲", memo:"今期予算は未定", last_called_at:"2026-07-09T11:00:00+09:00", next_action_at:"2026-07-18T11:00:00+09:00" },
  { id:"c5", name:"石川モビリティ株式会社", industry:"自動車販売", location:"石川県野々市市", phone:"076-246-3320", website_url:"https://example.com/ishikawa-mobility", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"岡本様", contact_department:"人事課", heat:"高", owner_id:"m-tsuji", owner_name:"辻 保", memo:"新卒母集団形成を相談したい", last_called_at:"2026-07-14T14:42:00+09:00", next_action_at:"2026-07-17T14:00:00+09:00" },
  { id:"c6", name:"株式会社犀川デザイン", industry:"広告・制作", location:"石川県金沢市", phone:"076-221-5518", website_url:"https://example.com/saigawa-design", source_url:"https://example.com/list", list_source:"デモリスト", contact_name:"西川様", contact_department:"代表", heat:"低", owner_id:"m-yamada", owner_name:"山田 花子", memo:"" },
];

export const demoLogs: CallLog[] = [
  { id:"l1", company_id:"c2", company_name:"金沢フーズ株式会社", caller_id:"m-yamada", caller_name:"山田 花子", result:"資料送付", note:"採用SNS事例と料金表を希望。社内で検討予定。", next_action_at:"2026-07-16T10:00:00+09:00", created_at:"2026-07-14T15:18:00+09:00" },
  { id:"l2", company_id:"c5", company_name:"石川モビリティ株式会社", caller_id:"m-tsuji", caller_name:"辻 保", result:"アポ獲得", note:"新卒採用の母集団形成が課題。オンライン商談を設定。", next_action_at:"2026-07-17T14:00:00+09:00", created_at:"2026-07-14T14:42:00+09:00" },
  { id:"l3", company_id:"c3", company_name:"株式会社加賀建設", caller_id:"m-sato", caller_name:"佐藤 健", result:"担当者不在", note:"前田様は現場外出中。午前中がつながりやすい。", next_action_at:"2026-07-15T10:00:00+09:00", created_at:"2026-07-14T13:05:00+09:00" },
  { id:"l4", company_id:"c4", company_name:"能登観光開発株式会社", caller_id:"m-takahashi", caller_name:"高橋 美咲", result:"再架電", note:"繁忙期のため、来週改めて連絡。", next_action_at:"2026-07-18T11:00:00+09:00", created_at:"2026-07-14T11:34:00+09:00" },
];
