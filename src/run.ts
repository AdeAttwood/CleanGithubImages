import * as core from "@actions/core";
import { api, Response } from "./api";

type Container = {
  id: number;
  created_at: string;
  metadata: {
    container: {
      tags: string[];
    };
  };
};

type PackageInfo = {
  name: string;
  repository: {
    full_name: string;
  };
};

export async function run() {
  const user = core.getInput("user");
  const org = core.getInput("org");
  if (user && org) {
    throw new Error("Only one of user or org can be specified");
  }

  if (!user && !org) {
    throw new Error("One of user or org must be specified");
  }

  const packageName = core.getInput("package", { required: true });
  const prefix = user ? `users/${user}` : `orgs/${org}`;
  const packageUrl = `/${prefix}/packages/container/${packageName}`;

  const pattern = core.getInput("tag-pattern");
  const tagPattern = pattern ? new RegExp(pattern) : null;
  const prPattern = new RegExp(core.getInput("pr-pattern") || "^pr-([0-9]+)$");
  const keepInput = core.getInput("keep") || "10";
  const keep = Number(keepInput);
  if (!/^\d+$/.test(keepInput) || !Number.isSafeInteger(keep)) {
    throw new Error("keep must be a non-negative integer");
  }

  const packageInfo = await api<PackageInfo>(packageUrl);
  if (packageInfo.status !== 200 || !packageInfo.data?.repository?.full_name) {
    throw new Error("Failed to fetch package repository");
  }

  const pullRequestNumbers = new Set<number>();
  for (let page = 1; ; page++) {
    const pullRequests = await api<{ number: number }[]>(
      `/repos/${packageInfo.data.repository.full_name}/pulls?per_page=100&state=open&page=${page}`,
    );
    if (pullRequests.status !== 200 || !Array.isArray(pullRequests.data)) {
      throw new Error("Failed to fetch pull requests");
    }
    if (pullRequests.data.length === 0) {
      break;
    }
    for (const pr of pullRequests.data) {
      pullRequestNumbers.add(pr.number);
    }
  }

  const taggedToDelete: Container[] = [];
  const untaggedVersions: Container[] = [];
  const matchingTags: Container[] = [];

  let page = 1;
  let versions: Response<Container[]> = { status: 0, data: [] };

  do {
    const currentPage = page++;
    core.debug(`Fetching versions page ${currentPage}`);
    versions = await api<Container[]>(
      `${packageUrl}/versions?per_page=100&page=${currentPage}`,
    );

    if (versions.status !== 200 || !Array.isArray(versions.data)) {
      throw new Error("Failed to fetch package versions");
    }

    for (const version of versions.data) {
      if (!Number.isFinite(Date.parse(version.created_at))) {
        throw new Error(`Invalid creation date for version ${version.id}`);
      }
      const tags = version.metadata.container.tags;
      if (tags.length === 0) {
        untaggedVersions.push(version);
        continue;
      }

      const prNumbers = tags.map((tag) => {
        const match = prPattern.exec(tag);
        if (!match) {
          return null;
        }
        if (!/^[0-9]+$/.test(match[1] || "") || !Number.isSafeInteger(Number(match[1]))) {
          throw new Error("pr-pattern must capture the PR number in its first capture group");
        }
        return Number(match[1]);
      });
      const shouldDelete = tags.every(
        (tag, index) => prNumbers[index] !== null
          ? !pullRequestNumbers.has(prNumbers[index])
          : tagPattern?.test(tag),
      );

      if (!shouldDelete) {
        core.debug(
          `Skipping protected version ${version.id} with tags ${tags.join(", ")}`,
        );
        continue;
      }

      if (prNumbers.includes(null)) {
        matchingTags.push(version);
      } else {
        taggedToDelete.push(version);
      }
    }
  } while (versions.data.length > 0);

  for (const group of [untaggedVersions, matchingTags]) {
    group.sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
    );
    for (const version of group.splice(0, keep)) {
      core.debug(`Retaining recent version ${version.id}`);
    }
    taggedToDelete.push(...group);
  }

  for (const version of taggedToDelete) {
    core.info(
      `Deleting version ${version.id} with tags ${version.metadata.container.tags.join(", ")}`,
    );
    const result = await api(`${packageUrl}/versions/${version.id}`, "DELETE");
    if (result.status !== 204) {
      throw new Error(`Failed to delete version ${version.id}`);
    }
  }
}
