// The hosted marketing site is being retired (see docs/rewrite/clean-room-plan.md).
// Contact submissions were forwarded to a third-party CRM; that is removed so no
// form data leaves this service.
export async function POST() {
  return Response.json({ error: "The contact form is no longer available." }, { status: 410 });
}
