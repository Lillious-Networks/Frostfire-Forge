import GitHubAPI from "../../../../github-api-extended/api/main";

const args = process.argv.slice(2);

const github_token_index = args.findIndex((arg) => arg === '--token');
if (github_token_index === -1) {
  throw new Error('Github token not provided');
}

const github_token = args[github_token_index + 1];

const repository_index = args.findIndex((arg) => arg === '--repository');
if (repository_index === -1) {
  throw new Error('Repository not provided');
}

const repository = args[repository_index + 1]?.split('/')[1] || args[repository_index + 1];
if (!repository) {
  throw new Error('Repository not provided');
}

// GitHub API configuration
const github = new GitHubAPI({
  version: "2022-11-28",
  token: github_token as string,
  url: "https://api.github.com",
  repository: {
  name: repository as string,
  owner: "Lillious-Networks",
  },
});

const tags = await github?.tags?.list();
const tag = await getLatestTag(tags);

// Return default release number if no tag found
if (!tag) {
  const defaultTag = defaultReleaseNumber();
  process.stdout.write(`${defaultTag}\n`);
  process.exit(0);
}

// Increment version based on current date and existing tag
const newTag = incrementVersion(tag);
if (!newTag) {
  throw new Error('Failed to increment version');
}

// Output the new tag
process.stdout.write(`${newTag}\n`);

function defaultReleaseNumber() {
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const quarter = Math.floor((currentDate.getMonth() + 3) / 3);
  const build = 1;
  return `${year}.${quarter}.${build}`;
}

function incrementVersion(version: string): string {
  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.floor((new Date().getMonth() + 3) / 3);

  const [major, minor, patch] = version
  .split(".")
  .map((v) => Number(v) || 0) as [number, number, number];

  if (currentYear > major) {
  return `${currentYear}.${currentQuarter}.1`;
  }

  if (currentQuarter > minor) {
  return `${currentYear}.${currentQuarter}.1`;
  }

  if (currentQuarter === minor) {
  return `${currentYear}.${currentQuarter}.${patch + 1}`;
  }

  return `${currentYear}.${currentQuarter}.1`;
}


async function getLatestTag (tags: any) {
  // If no tags are found for the current year return undefined
  if (tags?.length === 0) {
  return undefined;
  }

  const tagNames = tags.map((tag: any) => tag.name);
  const sortedTags = [] as any[];
  tagNames.forEach(
  (tag: any) => {
    const major = parseInt(tag.split('.')[0]);
    const minor = parseInt(tag.split('.')[1]);
    const patch = parseInt(tag.split('.')[2]);

    sortedTags.push({ tag: tag, major: major, minor: minor, patch: patch });
  }
  );
  // Return the latest tag
  sortedTags.sort((a, b) => {
  if (a.major === b.major) {
    if (a.minor === b.minor) {
    return a.patch - b.patch;
    }
    return a.minor - b.minor;
  }
  return a.major - b.major;
  });

  return sortedTags[sortedTags.length - 1].tag;
};
