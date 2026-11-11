# Consumer GitHub App and Secret Setup

Use this guide before adding a Dependency Update Advisor caller to a consumer
repository. It records the repeatable operator setup. The consumer's adoption
record retains its own App identity, exact revisions, and trial evidence; never
put secret values, private-key material, or private consumer details here.

The caller runs from a trusted `workflow_run`, not directly from Dependabot's
pull request event. Store these values as repository **Actions** secrets. Do
not add them to the Dependabot secret store unless a separate workflow requires
them. The no-write rehearsal remains the proof that the secrets resolve in the
actual `workflow_run` context.

## Before creating credentials

1. Confirm the consumer's approved adoption record names its intended CI
   workflow and whether it already has a reviewer or a required status check.
   Keep an existing reviewer active through adoption.
2. Confirm that `dependabot-review` is advisory; do not make it a required
   check.
3. Decide which account will own the GitHub App. Use an account controlled by
   the consumer's maintainers, not a personal account that might later lose
   access.

## Create the GitHub App

1. Open GitHub **Settings**, then **Developer settings**, then **GitHub Apps**,
   and select **New GitHub App**.
2. Give the App a consumer-specific name and a homepage that identifies its
   owner. Disable webhooks: this integration needs no webhook delivery.
3. Under **Repository permissions**, grant exactly:

   - **Issues: Read and write** — manages the App-owned review comment.
   - **Commit statuses: Read and write** — publishes the advisory status on
     the verified current head.

   GitHub supplies metadata read access implicitly. Do not add Administration,
   Actions, Checks, Contents, Pull requests, or any organization/account
   permission for this reviewer.

4. Create the App. From its **General** settings, copy its **Client ID**; this
   is the value for `review_app_client_id`. It is not the numeric App ID.
5. Open **Credentials** then **Key pairs**, choose **New key**, and keep the
   downloaded PEM private. Its complete contents, including the begin/end
   lines, are the value for `review_app_private_key`. Do not commit it, paste it
   into an issue, or send it in chat.

GitHub's current App-registration guidance is [Choosing permissions for a
GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
and [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

## Install with one-repository scope

1. On the App's settings page, select **Install App** and choose the consumer's
   account or organization.
2. Select **Only select repositories**, then select only the consumer
   repository. Do not choose all repositories.
3. Review the requested permissions one final time: only Issues and Commit
   statuses may be write-capable. Complete installation.
4. Record the App name/slug, installation account, selected repository, and
   granted permissions in the consumer's private adoption record. Do not record
   its private key there.

GitHub documents the selected-repository install flow in [Installing your own
GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

## Add repository Actions secrets

1. Open the consumer repository's **Settings** → **Secrets and variables** →
   **Actions** → **Secrets** → **New repository secret**.
2. Add these three names exactly:

   | Name                     | Value                                                |
   | ------------------------ | ---------------------------------------------------- |
   | `llm_api_key`            | The consumer's Mistral API key.                      |
   | `review_app_client_id`   | The GitHub App Client ID from the App settings page. |
   | `review_app_private_key` | The complete PEM private key generated above.        |

3. Do not add `GITHUB_TOKEN`: GitHub creates it for each workflow run. Do not
   use repository variables, `secrets: inherit`, a shared unscoped organization
   secret, or the Dependabot secret store for these caller inputs.
4. Verify only secret **names**, never values. For a repository the maintainer
   can run:

   ```sh
   gh secret list --repo OWNER/REPOSITORY
   ```

   The output must include all three required names. Other unrelated repository
   secrets do not become inputs to this integration.

GitHub's [repository-secret instructions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
cover the UI and CLI flows. The reusable workflow maps the three values by name;
GitHub does not automatically pass secrets to a reusable workflow, so the
caller must map each named secret explicitly.

## Handoff and verification

1. Tell the adoption implementer the App's public name or slug and that the
   three Actions secret names are present. Never provide secret values.
2. The implementer adds the SHA-pinned caller and contract test. Before merge,
   verify the App installation scope and permissions using the App settings
   page or a permitted API read.
3. After the caller is merged, run the no-write rehearsal on a current-head
   Dependabot PR. It is the required proof that the trusted `workflow_run`
   receives the named secrets, resolves the pinned workflow, and writes neither
   a status nor a comment.
4. A later production-publication gate is still required before any live
   status/comment trial. Do not infer it from credential setup or a no-write
   rehearsal.

See [Repository adoption](specs/SPEC-repo-adoption.md) for the complete caller,
current-head, rollback, and live-trial contract.
