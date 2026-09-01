// Shared plain-JavaScript rendering also runs in package preflight before dependency setup.
export const OPENCLAW_RELEASE_TAG_PATTERN =
  /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:(?:alpha|beta)\.[1-9][0-9]*|[1-9][0-9]*))?$/u;

const CONTRIBUTION_RECORD_HEADING = "### Complete contribution record";
const RELEASE_ACCOUNTING_HEADING = "### Release accounting";
const PULL_REQUESTS_HEADING = "### Pull requests";
const COMPACT_ACCOUNTING_HEADING = "### Pull requests and direct commits";

export function validateReleaseNotesRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
}

export function validateReleaseNotesTag(tag) {
  if (!OPENCLAW_RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`invalid release tag: ${tag}`);
  }
}

function tagPinnedChangelogUrl(repository, tag, anchor) {
  validateReleaseNotesRepository(repository);
  validateReleaseNotesTag(tag);
  return `https://github.com/${repository}/blob/${tag}/CHANGELOG.md#${anchor}`;
}

function headingIndexOutsideFences(markdown, heading) {
  let offset = 0;
  let fence;
  for (const segment of markdown.split(/(?<=\n)/u)) {
    const line = segment.replace(/\n$/u, "");
    const fenceMatch = line.match(/^\s*(?<marker>`{3,}|~{3,})/u);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker;
      if (!fence) {
        fence = marker;
      } else if (marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length) {
        fence = undefined;
      }
    } else if (!fence && line === heading) {
      return offset;
    }
    offset += segment.length;
  }
  return -1;
}

export function compactReleaseNotes(section, repository, tag) {
  const recordIndex = headingIndexOutsideFences(section, CONTRIBUTION_RECORD_HEADING);
  if (recordIndex >= 0) {
    const editorialNotes = section.slice(0, recordIndex).trimEnd();
    const contributionRecordUrl = tagPinnedChangelogUrl(
      repository,
      tag,
      "complete-contribution-record",
    );
    const body = [
      editorialNotes,
      "",
      CONTRIBUTION_RECORD_HEADING,
      "",
      `The full contribution record is available in the tag-pinned [CHANGELOG.md](${contributionRecordUrl}).`,
    ].join("\n");
    return { body, editorialNotes };
  }

  const accountingIndex = headingIndexOutsideFences(section, RELEASE_ACCOUNTING_HEADING);
  const pullRequestsIndex = headingIndexOutsideFences(section, PULL_REQUESTS_HEADING);
  if (accountingIndex < 0 || pullRequestsIndex <= accountingIndex) {
    return null;
  }
  const editorialNotes = section.slice(0, pullRequestsIndex).trimEnd();
  const contributionRecordUrl = tagPinnedChangelogUrl(repository, tag, "pull-requests");
  const body = [
    editorialNotes,
    "",
    COMPACT_ACCOUNTING_HEADING,
    "",
    `The full pull request and direct-commit record is available in the tag-pinned [CHANGELOG.md](${contributionRecordUrl}).`,
  ].join("\n");
  return { body, editorialNotes };
}
