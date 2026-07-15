export type Heat = "高" | "中" | "低";
export type CallResult = "アポ獲得" | "資料送付" | "再架電" | "担当者不在" | "見込みなし" | "その他";

export interface Company {
  id: string;
  name: string;
  industry: string;
  location: string;
  phone: string;
  website_url?: string;
  source_url?: string;
  list_source?: string;
  contact_name: string;
  contact_department?: string;
  heat: Heat;
  owner_name: string;
  memo: string;
  last_called_at?: string;
  next_action_at?: string;
  created_at?: string;
}

export interface CallLog {
  id: string;
  company_id: string;
  company_name: string;
  caller_name: string;
  result: CallResult;
  note: string;
  transcript?: string;
  ai_summary?: string;
  next_action_at?: string;
  created_at: string;
}

export interface TranscriptAnalysis {
  result: CallResult;
  heat: Heat;
  summary: string;
  contact_name: string | null;
  challenges: string[];
  next_action: string;
  next_action_at: string | null;
  confidence: number;
}
