import * as core from "@actions/core";

type Method = "GET" | "POST" | "PUT" | "DELETE";

export type Response<T> = {
  status: number;
  data: T | null;
};

export async function api<T>(
  path: string,
  method: Method = "GET",
): Promise<Response<T>> {
  const token = core.getInput("token") || process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  const versionsRequest = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
  });

  try {
    return {
      status: versionsRequest.status,
      data: await versionsRequest.json(),
    };
  } catch {
    return {
      status: versionsRequest.status,
      data: null,
    };
  }
}
