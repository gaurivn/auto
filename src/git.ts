import GHub from '@octokit/rest';
import gitlogNode, { ICommit } from 'gitlog';
import tinyColor from 'tinycolor2';
import { promisify } from 'util';

import { Memoize } from 'typescript-memoize';

import { ILabelDefinition } from './release';
import execPromise from './utils/exec-promise';
import { dummyLog, ILogger } from './utils/logger';

const gitlog = promisify(gitlogNode);

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>> &
  Partial<Pick<T, K>>;

export type IPRInfo = Omit<GHub.ReposCreateStatusParams, 'owner' | 'repo'>;

export interface IGitOptions {
  owner: string;
  repo: string;
  baseUrl?: string;
  token?: string;
}

export function getRandomColor() {
  return Math.floor(Math.random() * 16777215)
    .toString(16)
    .padStart(6, '0');
}

class GitAPIError extends Error {
  constructor(api: string, args: object, origError: Error) {
    super(
      `Error calling github: ${api}\n\twith: ${JSON.stringify(args)}.\n\t${
        origError.message
      }`
    );
  }
}

const makeCommentIdentifier = (context: string) =>
  `<!-- GITHUB_RELEASE COMMENT: ${context} -->`;

// A class to interact with the local git instance and the git remote.
// currently it only interfaces with GitHub.
export default class Git {
  readonly options: IGitOptions;

  private readonly baseUrl: string;
  private readonly ghub: GHub;
  private readonly logger: ILogger;

  constructor(options: IGitOptions, logger: ILogger = dummyLog()) {
    this.logger = logger;
    this.options = options;
    this.baseUrl = this.options.baseUrl || 'https://api.github.com';

    this.logger.veryVerbose.info(`Initializing GitHub with: ${this.baseUrl}`);
    this.ghub = new GHub({
      baseUrl: this.baseUrl,
      auth: `token ${this.options.token}`,
      previews: ['symmetra-preview']
    });
  }

  @Memoize()
  async getLatestReleaseInfo() {
    const latestRelease = await this.ghub.repos.getLatestRelease({
      owner: this.options.owner,
      repo: this.options.repo
    });

    return latestRelease.data;
  }

  @Memoize()
  async getLatestRelease(): Promise<string> {
    try {
      const latestRelease = await this.getLatestReleaseInfo();

      this.logger.veryVerbose.info(
        'Got response for "getLatestRelease":\n',
        latestRelease
      );
      this.logger.verbose.info('Got latest release:\n', latestRelease);

      return latestRelease.tag_name;
    } catch (e) {
      if (e.status === 404) {
        this.logger.verbose.info(
          "Couldn't find latest release on GitHub, using first commit."
        );
        return this.getFirstCommit();
      }

      throw e;
    }
  }

  async getCommitDate(sha: string): Promise<string> {
    const date = await execPromise('git', ['show', '-s', '--format=%ci', sha]);
    const [day, time, timezone] = date.split(' ');

    return `${day}T${time}${timezone}`;
  }

  async getFirstCommit(): Promise<string> {
    const list = await execPromise('git', ['rev-list', 'HEAD']);
    return list.split('\n').pop() as string;
  }

  async getSha(): Promise<string> {
    const result = await execPromise('git', ['rev-parse', 'HEAD']);

    this.logger.verbose.info(`Got commit SHA from HEAD: ${result}`);

    return result;
  }

  @Memoize()
  async getLabels(prNumber: number) {
    this.logger.verbose.info(`Getting labels for PR: ${prNumber}`);

    const args = {
      owner: this.options.owner,
      repo: this.options.repo,
      number: prNumber
    };

    this.logger.verbose.info('Getting issue labels using:', args);

    try {
      const labels = await this.ghub.issues.listLabelsOnIssue(args);
      this.logger.veryVerbose.info(
        'Got response for "listLabelsOnIssue":\n',
        labels
      );
      this.logger.verbose.info('Found labels on PR:\n', labels.data);

      return labels.data.map(l => l.name);
    } catch (e) {
      throw new GitAPIError('listLabelsOnIssue', args, e);
    }
  }

  async getProjectLabels() {
    this.logger.verbose.info(
      `Getting labels for project: ${this.options.repo}`
    );

    const args = {
      owner: this.options.owner,
      repo: this.options.repo
    };

    try {
      const labels = await this.ghub.issues.listLabelsForRepo(args);
      this.logger.veryVerbose.info(
        'Got response for "getProjectLabels":\n',
        labels
      );
      this.logger.verbose.info('Found labels on project:\n', labels.data);

      return labels.data.map(l => l.name);
    } catch (e) {
      throw new GitAPIError('getProjectLabels', args, e);
    }
  }

  @Memoize()
  async getGitLog(start: string, end = 'HEAD'): Promise<ICommit[]> {
    const log = await gitlog({
      repo: process.cwd(),
      number: Number.MAX_SAFE_INTEGER,
      fields: ['hash', 'authorName', 'authorEmail', 'rawBody'],
      branch: `${start.trim()}..${end.trim()}`
    });

    return log.map(commit => ({
      hash: commit.hash,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      subject: commit.rawBody!
    }));
  }

  @Memoize()
  async getUserByEmail(email: string) {
    const search = (await this.ghub.search.users({
      q: `in:email ${email}`
    })).data;

    return search && search.items.length > 0
      ? search.items[0]
      : { login: email };
  }

  @Memoize()
  async getUserByUsername(username: string) {
    return (await this.ghub.users.getByUsername({
      username
    })).data;
  }

  @Memoize()
  async getPullRequest(pr: number) {
    this.logger.verbose.info(`Getting Pull Request: ${pr}`);

    const args = {
      owner: this.options.owner,
      repo: this.options.repo,
      number: pr
    };

    this.logger.verbose.info('Getting pull request info using:', args);

    const result = await this.ghub.pulls.get(args);

    this.logger.veryVerbose.info('Got pull request data\n', result);
    this.logger.verbose.info('Got pull request info');

    return result;
  }

  async searchRepo(options: GHub.SearchIssuesAndPullRequestsParams) {
    const repo = `repo:${this.options.owner}/${this.options.repo}`;
    options.q = `${repo} ${options.q}`;

    this.logger.verbose.info('Searching repo using:\n', options);

    const result = await this.ghub.search.issuesAndPullRequests(options);

    this.logger.veryVerbose.info('Got response from search\n', result);
    this.logger.verbose.info('Searched repo on GitHub.');

    return result.data;
  }

  async createStatus(prInfo: IPRInfo) {
    const args = {
      ...prInfo,
      owner: this.options.owner,
      repo: this.options.repo
    };

    this.logger.verbose.info('Creating status using:\n', args);

    const result = await this.ghub.repos.createStatus(args);

    this.logger.veryVerbose.info('Got response from createStatues\n', result);
    this.logger.verbose.info('Created status on GitHub.');

    return result;
  }

  async createLabel(name: string, label: ILabelDefinition) {
    this.logger.verbose.info(`Creating "${name}" label :\n${label.name}`);

    const color = label.color
      ? tinyColor(label.color).toString('hex6')
      : tinyColor.random().toString('hex6');
    const result = await this.ghub.issues.createLabel({
      name: label.name,
      owner: this.options.owner,
      repo: this.options.repo,
      color: color.replace('#', ''),
      description: label.description
    });

    this.logger.veryVerbose.info('Got response from createLabel\n', result);
    this.logger.verbose.info('Created label on GitHub.');

    return result;
  }

  async addLabelToPr(pr: number, label: string) {
    this.logger.verbose.info(`Creating "${label}" label to PR ${pr}`);

    const result = await this.ghub.issues.addLabels({
      number: pr,
      owner: this.options.owner,
      repo: this.options.repo,
      labels: [label]
    });

    this.logger.veryVerbose.info('Got response from addLabels\n', result);
    this.logger.verbose.info('Added labels on Pull Request.');

    return result;
  }

  async lockIssue(issue: number) {
    this.logger.verbose.info(`Locking #${issue} issue...`);

    const result = await this.ghub.issues.lock({
      number: issue,
      owner: this.options.owner,
      repo: this.options.repo
    });

    this.logger.veryVerbose.info('Got response from lock\n', result);
    this.logger.verbose.info('Locked issue.');

    return result;
  }

  @Memoize()
  async getProject() {
    this.logger.verbose.info('Getting project from GitHub');

    const result = (await this.ghub.repos.get({
      owner: this.options.owner,
      repo: this.options.repo
    })).data;

    this.logger.veryVerbose.info('Got response from repos\n', result);
    this.logger.verbose.info('Got project information.');

    return result;
  }

  async getPullRequests(options?: Partial<GHub.PullsListParams>) {
    this.logger.verbose.info('Getting pull requests...');

    const result = (await this.ghub.pulls.list({
      owner: this.options.owner.toLowerCase(),
      repo: this.options.repo.toLowerCase(),
      ...options
    })).data;

    this.logger.veryVerbose.info('Got response from pull requests', result);
    this.logger.verbose.info('Got pull request');

    return result;
  }

  @Memoize()
  async getCommitsForPR(pr: number) {
    this.logger.verbose.info(`Getting commits for PR #${pr}`);

    const result = (await this.ghub.pulls.listCommits({
      owner: this.options.owner.toLowerCase(),
      repo: this.options.repo.toLowerCase(),
      number: pr
    })).data;

    this.logger.veryVerbose.info(`Got response from PR #${pr}\n`, result);
    this.logger.verbose.info(`Got commits for PR #${pr}.`);

    return result;
  }

  async createComment(message: string, pr: number, context = 'default') {
    const commentIdentifier = makeCommentIdentifier(context);

    this.logger.verbose.info('Using comment identifier:', commentIdentifier);

    this.logger.verbose.info('Getting previous comments on:', pr);

    const comments = await this.ghub.issues.listComments({
      owner: this.options.owner,
      repo: this.options.repo,
      number: pr
    });

    this.logger.veryVerbose.info('Got PR comments\n', comments);

    const oldMessage = comments.data.find(comment =>
      comment.body.includes(commentIdentifier)
    );

    if (oldMessage) {
      this.logger.verbose.info('Found previous message from same scope.');
      this.logger.verbose.info('Deleting previous comment');

      await this.ghub.issues.deleteComment({
        owner: this.options.owner,
        repo: this.options.repo,
        comment_id: oldMessage.id
      });

      this.logger.verbose.info('Successfully deleted previous comment');
    }

    this.logger.verbose.info('Creating new comment');

    const result = await this.ghub.issues.createComment({
      owner: this.options.owner,
      repo: this.options.repo,
      number: pr,
      body: `${commentIdentifier}\n${message}`
    });

    this.logger.veryVerbose.info(
      'Got response from creating comment\n',
      result
    );
    this.logger.verbose.info('Successfully posted comment to PR');

    return result;
  }

  async publish(releaseNotes: string, tag: string) {
    this.logger.verbose.info('Creating release on GitHub for tag:', tag);

    const result = await this.ghub.repos.createRelease({
      owner: this.options.owner,
      repo: this.options.repo,
      tag_name: tag,
      body: releaseNotes
    });

    this.logger.veryVerbose.info('Got response from createRelease\n', result);
    this.logger.verbose.info('Created GitHub release.');

    return result;
  }
}
