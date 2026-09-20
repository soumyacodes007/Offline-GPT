export const dynamic = "force-static"

const linkset = {
  linkset: [
    {
      anchor: "https://api.offlinegptlabs.com",
      "service-desc": [
        {
          href: "https://api.offlinegptlabs.com/openapi.json",
          type: "application/vnd.oai.openapi+json;version=3.1",
          title: "OfflineGPT Den API — OpenAPI 3.1 document",
        },
      ],
      "service-doc": [
        {
          href: "https://offlinegptlabs.com/docs/api-reference",
          type: "text/html",
          title: "OfflineGPT Den API — human documentation",
        },
      ],
      status: [
        {
          href: "https://api.offlinegptlabs.com/health",
          type: "application/json",
          title: "OfflineGPT Den API — health endpoint",
        },
      ],
      "service-meta": [
        {
          href: "https://offlinegptlabs.com/llms.txt",
          type: "text/plain",
          title: "OfflineGPT llms.txt — agent-facing site guide",
        },
      ],
    },
  ],
}

export function GET() {
  return new Response(JSON.stringify(linkset, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
