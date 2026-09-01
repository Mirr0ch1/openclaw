export const pluginControlUiPathGlob = "extensions/*/browser/**";
export const controlUiTestGlobs = ["ui/src/**/*.test.ts", "extensions/*/browser/**/*.test.ts"];
export const controlUiE2eTestGlobs = [
  "ui/src/**/*.e2e.test.ts",
  "extensions/*/browser/**/*.e2e.test.ts",
];

/** Browser plugin source and tests share the Control UI owner, regardless of plugin id.
 * @param {string} file
 */
export function isPluginControlUiPath(file) {
  return /^extensions\/[^/]+\/browser(?:\/|$)/u.test(file);
}

/** @param {string} file */
export function isControlUiSourcePath(file) {
  return file.startsWith("ui/src/") || isPluginControlUiPath(file);
}

/** @param {string} relative */
export function isUiTestTarget(relative) {
  return (
    isControlUiSourcePath(relative) &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}
