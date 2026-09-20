import type { ReactNode } from "react";
import "./style.css";

export const metadata = {
  title: "OfflineGPT Review",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <a href="/">
            offlinegpt<span>/ review</span>
          </a>
          <span>Evidence, in context.</span>
        </header>
        {children}
      </body>
    </html>
  );
}
