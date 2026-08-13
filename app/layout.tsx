import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SaigeVision 项目转换",
  description: "在浏览器本机安全转换 SaigeVision V1 与 V2 项目文件。",
  applicationName: "SaigeVision Project Converter",
  openGraph: {
    title: "SaigeVision 项目转换",
    description: "V1 / V2 项目文件本机双向转换，不上传项目或图片。",
    images: [{ url: "/saigevision-converter-preview.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SaigeVision 项目转换",
    description: "V1 / V2 项目文件本机双向转换，不上传项目或图片。",
    images: ["/saigevision-converter-preview.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
