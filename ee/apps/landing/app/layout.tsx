import "./globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import { BotIdClient } from "botid/client";
import { WebMcpProvider } from "../components/webmcp-provider";
import { StructuredData } from "../components/structured-data";
import { getGithubData } from "../lib/github";
import { DownloadProvider } from "../components/download-link";

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "OfflineGPT",
  legalName: "Different AI",
  url: "https://offlinegptlabs.com",
  logo: "https://offlinegptlabs.com/offlinegpt-mark.svg",
  sameAs: ["https://github.com/soumyacodes007/offline-gpt"]
};

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata = {
  metadataBase: new URL("https://offlinegptlabs.com"),
  title: "OfflineGPT — Open source Claude Cowork alternative for teams",
  description:
    "Bring your own model and provider, wire in your tools and context, and ship reusable agent setups across your org — with guardrails built in.",
  alternates: {
    canonical: "/"
  },
  robots: {
    index: true,
    follow: true
  },
  openGraph: {
    type: "website",
    siteName: "OfflineGPT",
    locale: "en_US",
    images: ["/og-image-clean.png"]
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-image-clean.png"]
  }
};

const protectedRoutes = [
  { path: "/api/enterprise-contact", method: "POST" as const },
  { path: "/api/app-feedback", method: "POST" as const },
];

export default async function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const github = await getGithubData();
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        <StructuredData data={organizationSchema} />
        <BotIdClient protect={protectedRoutes} />
      </head>
      <body className="overflow-x-hidden antialiased">
        <WebMcpProvider />
        <DownloadProvider installers={github.installers}><>{children}</></DownloadProvider>
      </body>
    </html>
  );
}
