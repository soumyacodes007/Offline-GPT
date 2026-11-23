// OFFLINEGPT_EDITION=airgapped: this server runs inside a network without
// internet access, so it must never fall back to a public download or service.
export function isAirgappedEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OFFLINEGPT_EDITION?.trim().toLowerCase();
  return value === "airgapped" || value === "air-gapped" || value === "air_gapped";
}
