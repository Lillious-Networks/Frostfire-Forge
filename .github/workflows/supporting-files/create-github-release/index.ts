import GitHubAPI from "../../../../github-api-extended/api/main";

const args = process.argv.slice(2);
const release_number_index = args.findIndex((arg: string) => arg === '--release-number');
if (release_number_index === -1) {
    throw new Error('Release number not provided');
}
const release_number = args[release_number_index + 1];

const github_token_index = args.findIndex((arg: string) => arg === '--github-token');
if (github_token_index === -1) {
    throw new Error('Github token not provided');
}
const github_token = args[github_token_index + 1];

const repository_index = args.findIndex((arg: string) => arg === '--repository');
if (repository_index === -1) {
    throw new Error('Repository not provided');
}
const repository = args[repository_index + 1];
if (!repository) {
    throw new Error('Repository is empty');
}

const repository_name = repository?.split('/')[1] || repository;

const github = new GitHubAPI({
    version: "2022-11-28",
    token: github_token,
    url: "https://api.github.com",
    repository: {
        name: repository_name,
        owner: 'Lillious-Networks',
    }
});

const result = await github.releases.create({
    tag_name: release_number,
    body: `Automated release.`,
    name: `🧊🔥 Frostfire Forge 🔥🧊 - ${release_number}`,
    prerelease: false,
    make_latest: 'true',
    draft: false,
});

if ((result as any).error) {
    console.error(`Failed to create release for tag ${release_number}`);
    console.error(`Error: ${JSON.stringify((result as any).error)}`);
    process.exit(1);
}

console.log(`Successfully created release ${release_number}`);