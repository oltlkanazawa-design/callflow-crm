import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const configured=Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL&&process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY&&!process.env.NEXT_PUBLIC_SUPABASE_URL.includes("YOUR_PROJECT"));
  const allowDemo=process.env.NEXT_PUBLIC_ALLOW_DEMO!=="false";
  if(!configured&&allowDemo)return NextResponse.next({request});
  if(!configured&&!allowDemo&&request.nextUrl.pathname.startsWith("/dashboard"))return NextResponse.redirect(new URL("/login",request.url));
  let response=NextResponse.next({request});
  const supabase=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>request.cookies.getAll(),setAll(cookies){cookies.forEach(({name,value})=>request.cookies.set(name,value));response=NextResponse.next({request});cookies.forEach(({name,value,options})=>response.cookies.set(name,value,options))}}});
  const {data:{user}}=await supabase.auth.getUser();
  const path=request.nextUrl.pathname;
  if(!user&&path.startsWith("/dashboard"))return NextResponse.redirect(new URL("/login",request.url));
  if(user&&path==="/login")return NextResponse.redirect(new URL("/dashboard",request.url));
  return response;
}

export const config={matcher:["/dashboard/:path*","/login"]};
