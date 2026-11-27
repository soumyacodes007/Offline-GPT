# Platform spec: model gateway

The `model-gateway` service is the only way workspaces reach a model. It
speaks the OpenAI chat API, so OpenCode and other clients work unchanged.

## Keys

- Each member can have one active **inference key**. Creating a new one
  revokes the previous key. The key is shown once; only its hash is stored.
- A request is refused with 401 when the key is unknown or revoked, or when
  the member is inactive.

## Models

- Models are declared in configuration: an alias employees see, the upstream
  base URL (vLLM, Ollama or another OpenAI-compatible server inside the
  network), the upstream model name, a display name and the context length.
  The gateway never discovers models from the upstream, so the list is
  available before the upstream finishes loading.
- `GET /v1/models` lists only the models the member may use (policy kind
  `model`).
- `POST /v1/chat/completions` with a model the member may not use answers 403
  with a message that tells them to request access. Unknown models answer 404.

## Forwarding

- The request body is forwarded unchanged except for the model name. Streaming
  responses are streamed through as they arrive.
- For streaming requests the gateway asks the upstream to include usage in the
  final chunk.
- Upstream errors are passed through with their status. An unreachable
  upstream answers 502.

## Usage and quotas

- Every completion records one usage row: member, model alias, prompt and
  completion tokens (when the upstream reports them), status and time.
  Prompts and responses are never stored or logged.
- An optional daily token limit per member (UTC day) refuses new requests
  with 429 once the member's recorded tokens for the day reach it.
- Admins see usage per member and model in the control service.
