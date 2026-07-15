import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CallFlow CRM",
  description: "テレアポ営業チームのための営業管理CRM",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
