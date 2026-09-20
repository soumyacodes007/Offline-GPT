import { env } from "../env.js"

export function offlinegptYourConnectionsUrl(connectionId: string) {
  const url = new URL("/dashboard/your-connections", env.betterAuthUrl)
  url.searchParams.set("connectionId", connectionId)
  return url.toString()
}

export function offlinegptOrganizationConnectionsUrl() {
  return new URL("/dashboard/mcp-connections", env.betterAuthUrl).toString()
}
