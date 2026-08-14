import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const trustedOrigin = requestHeaders.get("x-saigevision-request-origin");
  let metadataBase = new URL("http://localhost");
  if (trustedOrigin) {
    try {
      const candidate = new URL(trustedOrigin);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") {
        metadataBase = new URL(candidate.origin);
      }
    } catch {
      // The Worker supplies this header from Request.url. Keep a safe local
      // fallback for direct SSR tests or non-Worker development runtimes.
    }
  }
  const description =
    "Classification / Segmentation 的 V1 / V2 项目本机双向转换，不上传项目或图片。";

  return {
    metadataBase,
    title: "SaigeVision 项目转换",
    description:
      "在浏览器本机安全转换 SaigeVision V1 与 V2 的 Classification 和 Segmentation 项目。",
    applicationName: "SaigeVision Project Converter",
    robots: "noindex, nofollow, noarchive",
    openGraph: {
      title: "SaigeVision 项目转换",
      description,
      images: [
        {
          url: new URL("/saigevision-converter-preview.png", metadataBase),
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "SaigeVision 项目转换",
      description,
      images: [new URL("/saigevision-converter-preview.png", metadataBase)],
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
  };
}

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
