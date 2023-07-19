import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";

const ThrottledOctokit = Octokit.plugin(throttling)

const octokitClient = () => new ThrottledOctokit({
    auth: "token " + process.env.GITHUB_ACCESS_TOKEN,
    throttle: {
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
        },
      },
})

export default octokitClient