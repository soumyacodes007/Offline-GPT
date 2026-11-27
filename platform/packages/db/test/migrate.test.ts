import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { members, openDatabase, teamMembers, teams } from "../src";

test("migrations build a working schema and are safe to re-run", async () => {
  const handle = openDatabase("pglite:memory");
  try {
    await handle.migrate();
    await handle.migrate();
    await handle.db.insert(members).values({ id: "m1", email: "a@example.test", name: "A" });
    await handle.db.insert(teams).values({ id: "t1", name: "Legal" });
    await handle.db.insert(teamMembers).values({ teamId: "t1", memberId: "m1" });
    const [row] = await handle.db.select().from(members).where(eq(members.id, "m1"));
    expect(row?.role).toBe("member");
    expect(row?.active).toBe(true);
    await expect((async () => { await handle.db.insert(members).values({ id: "m2", email: "a@example.test", name: "Dup" }); })()).rejects.toThrow();
    await handle.db.delete(members).where(eq(members.id, "m1"));
    expect(await handle.db.select().from(teamMembers)).toEqual([]);
  } finally {
    await handle.close();
  }
});

test("rejects unknown database URLs", () => {
  expect(() => openDatabase("mysql://x")).toThrow("DATABASE_URL");
});
