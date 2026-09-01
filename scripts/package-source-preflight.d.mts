type PackageSourcePreflightOptions = {
  allowUnreleasedChangelog?: boolean;
  sourceCommit?: string;
};

export function validatePackageSource(params: {
  aiManifestContent: string | null;
  allowUnreleasedChangelog?: boolean;
  changelogContent: string;
  rootManifestContent: string;
  sourceCommit?: string;
}): string;
export function validatePackageSourceRef(
  ref: string,
  options?: PackageSourcePreflightOptions,
): string;
export function validatePackageSourceDir(
  sourceDir: string,
  options?: PackageSourcePreflightOptions,
): string;
