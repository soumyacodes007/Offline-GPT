// The product edition. "hosted" is the default; "airgapped" is the self-hosted
// edition for networks without internet access. In the air-gapped edition every
// service refuses configuration that would make it call a public endpoint.

export type OfflineGPTEdition = "hosted" | "airgapped"

export function parseEdition(value: string | undefined): OfflineGPTEdition {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === "hosted") return "hosted"
  if (normalized === "airgapped" || normalized === "air-gapped" || normalized === "air_gapped") return "airgapped"
  throw new Error(`OFFLINEGPT_EDITION must be "hosted" or "airgapped" (got "${value}")`)
}

export const edition: OfflineGPTEdition = parseEdition(process.env.OFFLINEGPT_EDITION)
export const isAirgapped = edition === "airgapped"

/**
 * A link to the admin portal's request form, filled in for one resource, so a
 * member who is refused access can ask for it in one click. Null when the
 * portal's public origin (DEN_WEB_PUBLIC_ORIGIN) is not configured.
 */
export function accessRequestUrl(
  resource: { kind: string; id: string; label?: string },
  portalOrigin = process.env.DEN_WEB_PUBLIC_ORIGIN,
): string | null {
  const origin = portalOrigin?.trim().replace(/\/+$/, "")
  if (!origin) return null
  const url = new URL(`${origin}/dashboard/my-access`)
  url.searchParams.set("kind", resource.kind)
  url.searchParams.set("id", resource.id)
  if (resource.label) url.searchParams.set("label", resource.label)
  return url.toString()
}

/**
 * Settings that only make sense when the deployment can reach the public
 * internet. In the air-gapped edition, startup fails if any is set, so a
 * misconfiguration is caught at boot instead of as a silent outbound call.
 */
export function assertNoPublicServices(
  values: Record<string, string | undefined>,
  names: readonly string[],
  service: string,
): void {
  const set = names.filter((name) => values[name]?.trim())
  if (set.length > 0) {
    throw new Error(
      `${service}: OFFLINEGPT_EDITION=airgapped does not allow ${set.join(", ")}; these settings call public internet services.`,
    )
  }
}
