/** The few Docker Engine API calls the provisioner needs. */
export type DockerResponse = { status: number; body: unknown };
export type DockerTransport = (method: string, path: string, body?: unknown) => Promise<DockerResponse>;

const API = "/v1.43";

/**
 * Talk to the Docker Engine over its socket (`unix:///var/run/docker.sock`)
 * or over TCP (`http://docker-proxy:2375`).
 */
export function dockerTransport(url: string): DockerTransport {
  const socket = url.startsWith("unix://") ? url.slice("unix://".length) : null;
  const base = socket ? "http://docker" : url.replace(/\/+$/, "");
  return async (method, path, body) => {
    const response = await fetch(`${base}${API}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(socket ? { unix: socket } : {}),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
}

export class DockerError extends Error {
  constructor(operation: string, response: DockerResponse) {
    const detail = typeof response.body === "object" && response.body !== null && "message" in response.body ? String(response.body.message) : String(response.body);
    super(`Docker ${operation} failed (${response.status}): ${detail}`);
  }
}

export type ContainerSpec = {
  name: string;
  image: string;
  cmd: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  volume: string;
  mountPath: string;
  network: string;
  memoryMb: number;
  cpus: number;
};

export function createDocker(transport: DockerTransport) {
  async function expect(operation: string, ok: number[], method: string, path: string, body?: unknown): Promise<DockerResponse> {
    const response = await transport(method, path, body);
    if (!ok.includes(response.status)) throw new DockerError(operation, response);
    return response;
  }

  return {
    /** `running`, `stopped`, or `missing`. */
    async state(name: string): Promise<"running" | "stopped" | "missing"> {
      const response = await expect("inspect", [200, 404], "GET", `/containers/${encodeURIComponent(name)}/json`);
      if (response.status === 404) return "missing";
      const body = response.body;
      const running = typeof body === "object" && body !== null && "State" in body && typeof body.State === "object" && body.State !== null && "Running" in body.State && body.State.Running === true;
      return running ? "running" : "stopped";
    },
    async create(spec: ContainerSpec): Promise<void> {
      await expect("volume create", [201, 200], "POST", "/volumes/create", { Name: spec.volume, Labels: spec.labels });
      await expect("container create", [201], "POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, {
        Image: spec.image,
        Cmd: spec.cmd,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Labels: spec.labels,
        HostConfig: {
          Binds: [`${spec.volume}:${spec.mountPath}`],
          NetworkMode: spec.network,
          Memory: spec.memoryMb * 1024 * 1024,
          NanoCpus: Math.round(spec.cpus * 1e9),
          RestartPolicy: { Name: "unless-stopped" },
          SecurityOpt: ["no-new-privileges"],
        },
      });
    },
    async start(name: string): Promise<void> {
      await expect("start", [204, 304], "POST", `/containers/${encodeURIComponent(name)}/start`);
    },
    async stop(name: string): Promise<void> {
      await expect("stop", [204, 304, 404], "POST", `/containers/${encodeURIComponent(name)}/stop?t=20`);
    },
    async remove(name: string): Promise<void> {
      await expect("remove", [204, 404], "DELETE", `/containers/${encodeURIComponent(name)}?force=true`);
    },
    async removeVolume(name: string): Promise<void> {
      await expect("volume remove", [204, 404], "DELETE", `/volumes/${encodeURIComponent(name)}`);
    },
  };
}

export type Docker = ReturnType<typeof createDocker>;
