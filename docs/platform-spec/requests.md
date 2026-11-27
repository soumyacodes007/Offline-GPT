# Platform spec: access requests and audit

## Requests

- A member asks for a resource (kind + target) with a **purpose** (required,
  up to 1000 characters) and a **duration**: 1, 7, 30 or 90 days, or "until
  removed".
- Asking again for the same kind and target while a request is pending
  returns the pending one; it doesn't create a second.
- A member can have at most 20 pending requests.
- Pending requests expire 7 days after they were made.
- Owners and admins can approve or decline. Nobody can decide their own
  request.
- **Approving** is atomic: only a request that is still pending and not
  expired can be approved, so two admins approving at once give exactly one
  success. It writes one allow rule for that member, ending after the chosen
  duration, with the reason `Approved request: "<purpose>"`.
- **Declining** records an optional note for the member.
- The member can **cancel** their own pending request.
- Members see their own requests; admins see everyone's, filterable by status.
- Every create, approve, decline and cancel is audited.

## Audit log

- Admins can list audit events, newest first, 50 per page (up to 200), and
  page backwards with `before=<event id>`. They can filter by actor and by
  action prefix (`rule.`, `member.`, `request.`).
- Audit events are never changed or deleted through the API.
