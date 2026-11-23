import { describe, expect, test } from "bun:test"
import { assertNoPublicServices, parseEdition } from "./edition.ts"

describe("parseEdition", () => {
  test("defaults to hosted", () => {
    expect(parseEdition(undefined)).toBe("hosted")
    expect(parseEdition("")).toBe("hosted")
    expect(parseEdition("hosted")).toBe("hosted")
  })

  test("accepts air-gapped spellings", () => {
    expect(parseEdition("airgapped")).toBe("airgapped")
    expect(parseEdition("Air-Gapped")).toBe("airgapped")
    expect(parseEdition("air_gapped")).toBe("airgapped")
  })

  test("rejects unknown editions", () => {
    expect(() => parseEdition("cloud")).toThrow(/OFFLINEGPT_EDITION/)
  })
})

describe("assertNoPublicServices", () => {
  test("names every public setting that is set", () => {
    expect(() => assertNoPublicServices({ STRIPE_SECRET_KEY: "sk", LOOPS_API_KEY: " ", RESEND_API_KEY: "re" }, ["STRIPE_SECRET_KEY", "LOOPS_API_KEY", "RESEND_API_KEY"], "den-api"))
      .toThrow("den-api: OFFLINEGPT_EDITION=airgapped does not allow STRIPE_SECRET_KEY, RESEND_API_KEY")
  })

  test("passes when none are set", () => {
    expect(() => assertNoPublicServices({}, ["STRIPE_SECRET_KEY"], "den-api")).not.toThrow()
  })
})
