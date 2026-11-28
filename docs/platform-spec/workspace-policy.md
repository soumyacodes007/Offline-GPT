# Platform spec: workspace rules

Admins (the `access` permission) set what every member's assistant may do
inside their workspace. The workspace server enforces it with the same
controls a Den organization sets for desktops.

## Settings

- Run commands: allowed, or not at all.
- Commands that are never allowed (patterns with `*`).
- Optionally, the only sites the browser may open (origins without a path);
  setting this turns off web fetch and web search.
- Block browser uploads.

Nothing is restricted until an admin saves rules.

## Delivery and trust

- Saving pushes the rules to every running workspace at once; any that don't
  answer get them when they next start. Every workspace start delivers the
  current rules.
- The workspace server accepts rules only over its host-token API, which only
  the platform holds. It stores that the host set them and enforces them
  without a Den sign-in.
- On a desktop, a Den-verified policy always wins: it replaces host rules, and
  the host can't remove it.
- Every change is audited with the new rules.
