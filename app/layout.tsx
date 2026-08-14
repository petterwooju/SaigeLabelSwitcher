import type { Metadata } from "next";
import "./globals.css";

const siteUrl = "https://saige-label-switcher-beta.saigeai.com";
const title = "SaigeVision 项目转换";
const description =
  "Classification / Segmentation 的 V1 / V2 项目本机双向转换，不上传项目或图片。";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description:
    "在浏览器本机安全转换 SaigeVision V1 与 V2 的 Classification 和 Segmentation 项目。",
  applicationName: "SaigeVision Project Converter",
  robots: "noindex, nofollow, noarchive",
  alternates: { canonical: siteUrl },
  openGraph: {
    type: "website",
    url: siteUrl,
    title,
    description,
    images: [
      {
        url: "/saigevision-converter-preview.png",
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
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
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; base-uri 'self'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:"
        />
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>{children}</body>
    </html>
  );
}
