import { LegalPage } from "../../../components/legal-page";

export const metadata = {
  title: "OfflineGPT — Subscription Terms",
  description:
    "Subscription terms governing production use of OfflineGPT Enterprise Edition software by Different AI, doing business as OfflineGPT.",
  alternates: {
    canonical: "/terms/subscription"
  }
};

export default function SubscriptionTermsPage() {
  return <LegalPage file="terms/subscription/subscription-terms.md" />;
}
