export const OFFLINEGPT_WEB_ACCESS_REQUIRED_CODE = "offlinegpt_web_access_required" as const
export const OFFLINEGPT_WEB_ACCESS_REQUIRED_MESSAGE =
  "An active OfflineGPT Web subscription or complimentary access is required to use OfflineGPT Cloud."

export class OfflineGPTWebAccessRequiredError extends Error {
  readonly code = OFFLINEGPT_WEB_ACCESS_REQUIRED_CODE

  constructor() {
    super(OFFLINEGPT_WEB_ACCESS_REQUIRED_MESSAGE)
    this.name = "OfflineGPTWebAccessRequiredError"
  }
}

export function offlineGptWebAccessRequiredPayload() {
  return {
    error: OFFLINEGPT_WEB_ACCESS_REQUIRED_CODE,
    message: OFFLINEGPT_WEB_ACCESS_REQUIRED_MESSAGE,
  }
}
