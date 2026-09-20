import { readOrganizationMetadata } from "@offlinegpt/types/den/managed-models-policy"

export type OfflineGPTWebAccessSource = "subscription" | "complimentary" | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {}
  }
  if (typeof value !== "string") {
    return value
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function hasOfflineGPTWebComplimentaryAccess(metadata: Record<string, unknown> | string | null | undefined) {
  const complimentaryAccess = parseMetadata(metadata).complimentaryAccess
  return isRecord(complimentaryAccess) && complimentaryAccess.offlinegptWeb === true
}

export function setOfflineGPTWebComplimentaryAccess(metadata: unknown, enabled: boolean) {
  const nextMetadata = { ...readOrganizationMetadata(metadata) }
  const current = isRecord(nextMetadata.complimentaryAccess) ? nextMetadata.complimentaryAccess : {}
  const complimentaryAccess = { ...current }

  if (enabled) {
    complimentaryAccess.offlinegptWeb = true
  } else {
    delete complimentaryAccess.offlinegptWeb
  }

  if (Object.keys(complimentaryAccess).length > 0) {
    nextMetadata.complimentaryAccess = complimentaryAccess
  } else {
    delete nextMetadata.complimentaryAccess
  }

  return nextMetadata
}

export function resolveOfflineGPTWebAccess(input: {
  deploymentAvailable: boolean
  hasEligibleSubscription: boolean
  complimentaryAccess: boolean
}): {
  hasAccess: boolean
  accessSource: OfflineGPTWebAccessSource
  complimentaryAccess: boolean
} {
  const accessSource: OfflineGPTWebAccessSource = input.deploymentAvailable && input.hasEligibleSubscription
    ? "subscription"
    : input.complimentaryAccess
      ? "complimentary"
      : null

  return {
    hasAccess: accessSource !== null,
    accessSource,
    complimentaryAccess: input.complimentaryAccess,
  }
}
