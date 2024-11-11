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

  const packageInfo = await api<PackageInfo>(packageUrl);
  const pullRequests = await api<{ number: number }[]>(
    `/repos/${packageInfo.data?.repository.full_name}/pulls?per_page=100&state=open`,
  );

  if (pullRequests.data === null) {
    throw new Error("Failed to fetch pull requests");
  }

  const pullRequestNames = new Set(
    pullRequests.data.map((pr: any) => `pr-${pr.number}`),
  );

  const taggedToDelete = [];
  const untaggedVersions = [];

  let page = 1;
  let versions: Response<Container[]> = { status: 0, data: [] };

  do {
    const currentPage = page++;
    core.debug(`Fetching versions page ${currentPage}`);
    versions = await api<Container[]>(
      `${packageUrl}/versions?per_page=100&page=${currentPage}`,
    );

    if (versions.data === null) {
      throw new Error("Failed to fetch pull requests");
    }

    for (const version of versions.data) {
      const tags = version.metadata.container.tags;
      if (tags.length === 0) {
        untaggedVersions.push(version);
        continue;
      }

      const shouldDelete = tags.every(
        (tag: string) => tag.startsWith("pr-") && !pullRequestNames.has(tag),
      );

      if (!shouldDelete) {
        core.debug(
          `Skipping tagged version ${version.id} not a pr or pr is still open`,
        );
        continue;
      }

      taggedToDelete.push(version);
    }
  } while (versions.data.length > 0);

  for (const version of taggedToDelete) {
    const tags = version.metadata.container.tags;
    core.info(
      `Deleting tagged version ${version.id} with tags ${tags.join(", ")} no open pr found`,
    );

    const result = await api(`${packageUrl}/versions/${version.id}`, "DELETE");
    if (result.status !== 204) {
      core.error(`Failed to delete version ${version.id}`);
    }
  }

  const sortedUntaggedVersions = untaggedVersions.sort(function (a, b) {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  for (const version of sortedUntaggedVersions.slice(0, 5)) {
    core.debug(
      `Skipping untagged version ${version.id} in the top 5 latest versions`,
    );
  }

  for (const version of sortedUntaggedVersions.slice(5, -1)) {
    core.info(`Deleting untagged old version version ${version.id}`);
    const result = await api(`${packageUrl}/versions/${version.id}`, "DELETE");
    if (result.status !== 204) {
      core.error(`Failed to delete version ${version.id}`);
    }
  }
}
