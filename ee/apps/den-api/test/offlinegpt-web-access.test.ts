import { expect, test } from "bun:test"
import {
  hasOfflineGPTWebComplimentaryAccess,
  resolveOfflineGPTWebAccess,
  setOfflineGPTWebComplimentaryAccess,
} from "../src/offlinegpt-web-access.js"

test("complimentary Web access is an explicit metadata grant that preserves unrelated settings", () => {
  const original = {
    brandAppName: "OfflineGPT Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true },
  }
  const granted = setOfflineGPTWebComplimentaryAccess(original, true)

  expect(hasOfflineGPTWebComplimentaryAccess(granted)).toBe(true)
  expect(granted).toMatchObject({
    brandAppName: "OfflineGPT Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true, offlinegptWeb: true },
  })
  expect(original.complimentaryAccess).toEqual({ futureProduct: true })

  const revoked = setOfflineGPTWebComplimentaryAccess(granted, false)
  expect(hasOfflineGPTWebComplimentaryAccess(revoked)).toBe(false)
  expect(revoked).toMatchObject({
    brandAppName: "OfflineGPT Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true },
  })
})

test("revoking the only complimentary grant removes the empty metadata group", () => {
  expect(setOfflineGPTWebComplimentaryAccess({ complimentaryAccess: { offlinegptWeb: true } }, false)).toEqual({})
})

test("complimentary Web access is the only organization grant that overrides the deployment switch", () => {
  expect(resolveOfflineGPTWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: false,
    complimentaryAccess: true,
  })).toEqual({
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
  })

  expect(resolveOfflineGPTWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: true,
    complimentaryAccess: false,
  })).toEqual({
    hasAccess: false,
    accessSource: null,
    complimentaryAccess: false,
  })
})

test("an eligible paid subscription remains the authoritative source when both grants are present", () => {
  expect(resolveOfflineGPTWebAccess({
    deploymentAvailable: true,
    hasEligibleSubscription: true,
    complimentaryAccess: true,
  })).toEqual({
    hasAccess: true,
    accessSource: "subscription",
    complimentaryAccess: true,
  })
})
