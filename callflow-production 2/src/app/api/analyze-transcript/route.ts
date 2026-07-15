import { z } from "zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { createClient } from "@/lib/supabase/server";
import type { CallResult, Heat, TranscriptAnalysis } from "@/lib/types";

const inputSchema = z.object({ transcript: z.string().min(15).max(50000), company_name: z.string().optional() });
const analysisSchema = z.object({
  result: z.enum(["アポ獲得","資料送付","再架電","担当者不在","見込みなし","その他"]),
  heat: z.enum(["高","中","低"]),
  summary: z.string(),
  contact_name: z.string().nullable(),
  challenges: z.array(z.string()),
  next_action: z.string(),
  next_action_at: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

function localAnalysis(text: string): TranscriptAnalysis {
  const result: CallResult = /アポ|打ち合わせ|オンライン|日程|お時間.*いただ/.test(text) ? "アポ獲得"
    : /資料|メール|送って|見てみ/.test(text) ? "資料送付"
    : /不在|外出|席を外|戻り/.test(text) ? "担当者不在"
    : /必要ない|結構です|予定.*ない|お断り/.test(text) ? "見込みなし" : "再架電";
  const heat: Heat = result === "アポ獲得" ? "高" : result === "見込みなし" ? "低" : "中";
  const contact = text.match(/(?:担当|人事|総務)(?:の|は|：|:)?\s*([一-龠ぁ-んァ-ヶ]{2,4}?)(?=さん|様|です|と申します|[、。\s])/)?.[1] || null;
  const challenges:string[]=[];
  if(/応募|集まら|母集団/.test(text)) challenges.push("応募・母集団形成");
  if(/若手|新卒|学生/.test(text)) challenges.push("若手・新卒採用");
  if(/認知|知られて|知名度/.test(text)) challenges.push("企業認知");
  if(/SNS|インスタ|動画/.test(text)) challenges.push("SNS採用広報");
  const next_action=/明日/.test(text)?"明日再連絡":/来週/.test(text)?"来週再連絡":result==="資料送付"?"資料送付後、2営業日以内に確認":result==="アポ獲得"?"商談日程を確定":"次回対応日を設定";
  const parts=[];if(/採用|新卒|学生/.test(text))parts.push("採用・学生との接点づくりについて会話");if(challenges.length)parts.push(`${challenges.join("、")}の課題を確認`);if(/SNS|インスタ|動画/.test(text))parts.push("SNS採用広報を案内");if(result==="資料送付")parts.push("先方から資料確認の意向あり");if(result==="アポ獲得")parts.push("具体的な商談の了承を獲得");if(result==="担当者不在")parts.push("担当者不在のため再連絡が必要");
  return { result, heat, contact_name:contact, challenges, next_action, next_action_at:null, summary:(parts.length?parts:["通話内容を記録。次回対応の確認が必要"]).join("。")+"。", confidence:.72 };
}

async function openAIAnalysis(transcript:string,companyName?:string):Promise<TranscriptAnalysis|null>{
  if(!process.env.OPENAI_API_KEY)return null;
  const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const response=await openai.responses.parse({
    model:process.env.OPENAI_MODEL||"gpt-5.6-luna",
    input:[
      {role:"system",content:"あなたは日本語のBtoBテレアポ記録アシスタントです。発言にない事実を補わず、聞き取れない項目はnullまたは空配列にしてください。次回対応は営業担当がそのまま実行できる具体的な表現にします。"},
      {role:"user",content:`企業: ${companyName||"不明"}\n\n通話文字起こし:\n${transcript}`},
    ],
    text:{format:zodTextFormat(analysisSchema,"call_analysis")},
  });
  return response.output_parsed as TranscriptAnalysis|null;
}

export async function POST(request:Request){
  try{const configured=Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL&&process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY&&!process.env.NEXT_PUBLIC_SUPABASE_URL.includes("YOUR_PROJECT"));if(configured){const {data:{user}}=await (await createClient()).auth.getUser();if(!user)return Response.json({error:"ログインが必要です"},{status:401})}const parsed=inputSchema.safeParse(await request.json());if(!parsed.success)return Response.json({error:"文字起こしを確認してください"},{status:400});const ai=await openAIAnalysis(parsed.data.transcript,parsed.data.company_name);return Response.json(ai||localAnalysis(parsed.data.transcript));}
  catch{return Response.json({error:"解析処理に失敗しました"},{status:500})}
}
