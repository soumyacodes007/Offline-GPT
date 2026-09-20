# Arch Linux package

Use this directory to build and install the OfflineGPT package locally on Arch Linux without Docker.

## What this packaging does

- Targets `x86_64` and `aarch64` Arch Linux.
- Downloads the published Electron GitHub release asset for the current architecture.
- Installs the Electron bundle under `/opt/offlinegpt`.
- Adds `/usr/bin/offlinegpt`, a desktop entry, and the OfflineGPT icon.

## Prerequisites

- Arch Linux on `x86_64` or `aarch64`
- `base-devel`
- `curl`

Install the packaging prerequisites once:

```bash
sudo pacman -S --needed base-devel curl
```

## Build and install the current packaged version

From the repo root:

```bash
cd packaging/aur
makepkg -si
```

That will:

1. download the Electron tarball pinned in `PKGBUILD`
2. build an Arch package such as `offlinegpt-<version>-1-x86_64.pkg.tar.zst`
3. install it locally with `pacman`

After install, `offlinegpt` is available as the desktop launcher. The bundled sidecars remain inside `/opt/offlinegpt`; the package does not claim the standalone `opencode` command.

## Update the package to a newer release

If the GitHub release version changed, refresh the packaging metadata first:

```bash
scripts/aur/update-aur.sh v0.13.4
```

Then rebuild:

```bash
cd packaging/aur
makepkg -si
```

## Build without installing

```bash
cd packaging/aur
makepkg -s
```

This leaves the built package in `packaging/aur/` so you can install it later with:

```bash
sudo pacman -U offlinegpt-<version>-1-x86_64.pkg.tar.zst
```

## Verify the installed app

```bash
offlinegpt
```

If you want to confirm the package contents first:

```bash
pacman -Ql offlinegpt
```
