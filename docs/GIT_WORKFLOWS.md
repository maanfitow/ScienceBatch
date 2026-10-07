# Git Workflows

ScienceBatch uses the system Git installation for local repositories and GitHub or GitLab remotes. Git operations start only when you choose an action. The Source Control toolbar shows the repository root, current upstream, and ahead/behind counts from the latest fetch. Those counts do not trigger automatic network requests.

## Repository settings and credentials

Open **Repository settings** to inspect and manage remotes, select the remote used by Fetch, set a publication destination, or edit the Git author. Opening the dialog refreshes local Git metadata only. Fetch is an explicit network operation.

A remote edit changes its fetch URL. If the remote has a separate push URL, that URL is preserved and shown. Adding a remote requires a new name; edit an existing remote explicitly to change its URL. Pushing a branch with an established upstream always uses that configured remote and branch, regardless of the selected Fetch remote. For a branch without a valid upstream, choose a remote and destination branch, then select **Publish Branch** to establish tracking.

When no remote is configured, the Repository dialog links an existing repository and offers shortcuts to create one on GitHub or GitLab. For an existing local history, create an empty repository without a README, license, or `.gitignore`, then return to ScienceBatch and paste its clone URL. The shortcuts open the provider's official site; ScienceBatch does not create accounts or repositories.

Git authentication uses credentials already configured for your system Git client, such as SSH keys or a credential manager. ScienceBatch does not store remote passwords or tokens. If authentication fails or Git requests interactive credentials, finish setup in your system Git credential manager or SSH configuration, then retry.

Commit author identity is separate from remote authentication. Git's configured name and email are used when available. When missing, ScienceBatch asks for an author name and email and saves them in the repository's local Git configuration.

## Commits and remotes

A commit includes the staged changes in the repository's full root, including changes outside the project subfolder opened in ScienceBatch. Review the staged file list before committing. Unstaged changes stay out of the commit, and all open editor tabs must be saved before committing.

Ahead and behind counts reflect the most recent Fetch. Fetch does not update files in the working tree.

## Pull and push

Pull is available only when the working tree is clean and all editor tabs are saved. It uses fast-forward-only behavior. If local and remote history has diverged, resolve it with Git outside ScienceBatch, then fetch again. ScienceBatch reloads project files and diffs after a pull attempt, including when Git reports an error after changing files. It does not compile automatically or replace the visible PDF.

Push publishes the current commit to the configured upstream. A first publication requires choosing a remote and destination branch in Repository settings and selecting **Publish Branch**. A push timeout can leave the remote result uncertain. Fetch from the matching push destination before retrying; a local status refresh alone does not confirm the remote result. If a remote has a different fetch URL and push URL, select or configure a Fetch remote whose URL matches the push destination and fetch from it.

The GitHub and GitLab provider marks use SVG paths from [Simple Icons](https://simpleicons.org/), licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
