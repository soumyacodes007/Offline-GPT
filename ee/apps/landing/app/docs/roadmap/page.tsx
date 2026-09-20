import { RoadmapPageShell } from "../../../components/roadmap-page-shell";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph } from "../../../lib/seo";

export const metadata = {
  title: "OfflineGPT Roadmap",
  description:
    "What OfflineGPT supports today and what is coming next across desktop, hosted workspaces, external agents, and new surfaces.",
  alternates: {
    canonical: "/roadmap"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "OfflineGPT Roadmap | Your workspace, on every surface",
    description:
      "The roadmap for the OfflineGPT desktop app, portable agent capabilities, hosted workspaces, and every surface where work happens.",
    url: "https://offlinegptlabs.com/roadmap"
  }
};

export default async function DocsRoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
