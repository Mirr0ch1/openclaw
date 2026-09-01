import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("external plugin local dist build", () => {
  it("keeps excluded plugin graphs isolated and their runtime metadata loadable", async () => {
    const repoRoot = fs.realpathSync(tempDirs.make("openclaw-isolated-plugin-graphs-"));
    const plugins = [
      { id: "external-esm", runtimeFormat: "esm", publishToNpm: true },
      { id: "external-cjs", runtimeFormat: "cjs", publishToNpm: true },
      { id: "private-plugin", runtimeFormat: "esm", publishToNpm: false },
    ];
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.0",
        type: "module",
        files: ["dist/**", ...plugins.map(({ id }) => `!dist/extensions/${id}/**`)],
      }),
    );
    for (const { id, runtimeFormat, publishToNpm } of plugins) {
      const pluginRoot = path.join(repoRoot, "extensions", id);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: `@openclaw/${id}`,
          version: "1.0.0",
          type: "module",
          openclaw: {
            extensions: ["./index.ts"],
            setupEntry: "./setup-entry.ts",
            build: { runtimeFormat },
            release: { publishToNpm },
          },
        }),
      );
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({ id }));
      fs.writeFileSync(
        path.join(pluginRoot, "runtime-api.ts"),
        `export const identity = ${JSON.stringify(id)};`,
      );
      for (const entry of ["index.ts", "setup-entry.ts"]) {
        fs.writeFileSync(
          path.join(pluginRoot, entry),
          'export { identity } from "./runtime-api.js";',
        );
      }
    }
    await expect(
      buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" }),
    ).resolves.toMatchObject({
      pluginDirs: plugins.map(({ id }) => id).toSorted(),
    });
    copyBundledPluginMetadata({ repoRoot, env: {} });
    expect(fs.readdirSync(path.join(repoRoot, "dist"))).toEqual(["extensions"]);
    for (const { id, runtimeFormat } of plugins) {
      const pluginRoot = path.join(repoRoot, "dist/extensions", id);
      const metadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      expect(metadata.openclaw.extensions).toEqual([`./index${extension}`]);
      expect(metadata.openclaw.setupEntry).toBe(`./setup-entry${extension}`);
      expect(fs.existsSync(path.join(repoRoot, "extensions", id, "dist"))).toBe(false);
      const probe = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import { pathToFileURL } from "node:url";
        const root = pathToFileURL(process.cwd() + "/");
        const pkg = JSON.parse(readFileSync(new URL("package.json", root)));
        for (const entry of [...pkg.openclaw.extensions, pkg.openclaw.setupEntry]) {
          assert.equal((await import(new URL(entry, root))).identity, ${JSON.stringify(id)});
        }
      `,
        ],
        { cwd: pluginRoot, encoding: "utf8" },
      );
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
    }
  });

  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();

    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "extensions/codex",
        "extensions/diagnostics-otel",
        "extensions/discord",
        "extensions/msteams",
        "extensions/visitor-access",
        "extensions/diffs",
        "extensions/diffs-language-pack",
        "extensions/slack",
        "extensions/sms",
        "extensions/mxc",
        "extensions/whatsapp",
      ]),
    );
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("leaves Docker-selected external plugin compilation on the unified build path", () => {
    expect(
      listExternalPluginLocalDistPackageDirs({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
      }),
    ).toEqual([]);
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
