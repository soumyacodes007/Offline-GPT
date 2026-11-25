import { KnowledgeDocumentScreen } from "../../../_components/knowledge-admin";

export default async function KnowledgeDocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return <KnowledgeDocumentScreen documentId={documentId} />;
}
