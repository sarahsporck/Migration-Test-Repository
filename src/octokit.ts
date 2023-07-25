import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";

const ThrottledRetryOctokit = Octokit.plugin(throttling).plugin(retry)

const authenticate = async ({ file, owner, repo }: { file: string, owner: string, repo: string }) => {
  const appId = 365695
  const privateKey = readFileSync(file).toString('ascii')

  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } })
  const {
    data: { id: installationId },
  } = await octokit.apps.getRepoInstallation({ owner, repo })
  const {
    data: { token },
  } = await octokit.apps.createInstallationAccessToken({ installation_id: installationId })
  return token
}

const octokitClient = async (privateKey: string, owner: string, repo: string) =>
  authenticate({ file: privateKey, owner, repo })
    .then((token) => new ThrottledRetryOctokit({
      auth: token,
      throttle: {
        fallbackSecondaryRateRetryAfter: 120,
        onRateLimit: (retryAfter: number, options: any, octokit) => {
          octokit.log.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`,
          );

          // Retry twice after hitting a rate limit error, then give up
          if (options.request.retryCount <= 2) {
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onSecondaryRateLimit: (retryAfter: number, options: any, octokit) => {
          // does not retry, only logs a warning
          octokit.log.warn(
            `Secondary quota detected for request ${options.method} ${options.url}`,
          );
          if (options.request.retryCount <= 2) {
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true; 
          }
        },
      },
    }))

export default octokitClient