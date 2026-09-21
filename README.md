<div align="center">
  <img src="./offlinegpt-logo-transparent.svg" alt="OfflineGPT" width="128" />
  <h1>OfflineGPT</h1>
  <p>A local-first desktop workspace for getting real work done with AI agents.</p>
</div>

## Download

Installers are published on the [latest release page](https://github.com/soumyacodes007/Offline-GPT/releases/latest).

| Platform | Supported builds | Download format |
| --- | --- | --- |
| macOS | Apple Silicon and Intel | `.dmg` and `.zip` |
| Windows | x64 | `.exe` installer |
| Linux | x64 | `.AppImage` and `.tar.gz` |

> Community builds may show the operating system's standard unknown-developer warning until platform signing is configured.

## What it does

- Works with files and projects on your computer.
- Connects to supported AI providers without locking the interface to one vendor.
- Runs agent tools, browser workflows, reusable skills, and scheduled automations.
- Keeps local desktop work on your device unless you explicitly connect an external service.
- Supports macOS, Windows, and Linux from one codebase.

## Development

Requirements: Node.js 24, pnpm 11.4, and Bun 1.3.10 or newer.

```bash
pnpm install --frozen-lockfile
pnpm dev:electron
```

Useful checks:

```bash
pnpm typecheck
pnpm --filter @offlinegpt/desktop test:core
pnpm build:ui
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance and [docs/RELEASING.md](./docs/RELEASING.md) for the release process.

## Security

Please report security issues privately using the instructions in [SECURITY.md](./SECURITY.md).

## License

The desktop application is available under the repository's [MIT terms](./LICENSE). Code under `ee/` is governed by its accompanying enterprise license.
