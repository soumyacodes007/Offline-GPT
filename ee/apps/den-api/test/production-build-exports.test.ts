import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { missingProductionWorkspaceExports } from "../scripts/build.mjs"

describe("den-api production build", () => {
  test("production builds reject a missing workspace export target", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "den-api-export-contract-"))
    const dependencyDir = path.join(fixture, "node_modules", "@fixture", "runtime")

    try {
      mkdirSync(dependencyDir, { recursive: true })
      writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
        name: "fixture-service",
        dependencies: { "@fixture/runtime": "workspace:*" },
      }))
      writeFileSync(path.join(dependencyDir, "package.json"), JSON.stringify({
        name: "@fixture/runtime",
        exports: { ".": { default: "./dist/index.js" } },
      }))

      expect(missingProductionWorkspaceExports(fixture)).toEqual([
        "@fixture/runtime: ./dist/index.js",
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
