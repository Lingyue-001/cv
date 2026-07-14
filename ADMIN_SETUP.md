# Private content editor setup

The site now includes a private editor at `/cv/admin/`. Visitors do not see owner controls. After you sign in successfully, a small `+ Note`, `+ Project`, and context-sensitive `Edit` toolbar appears on the public site.

The editor commits Markdown to `src/content/note` or `src/content/post`. A commit to `main` starts the existing GitHub Pages workflow.

## 1. Create a GitHub OAuth App

Open GitHub **Settings → Developer settings → OAuth Apps → New OAuth App** and use:

- Homepage URL: `https://lingyue-001.github.io/cv/`
- Authorization callback URL: `https://YOUR-WORKER.workers.dev/auth/callback`

Keep the generated client ID and client secret for the Worker secrets below.

## 2. Create a repository write token

Create a fine-grained personal access token restricted to the `Lingyue-001/cv` repository. Grant only:

- Repository permissions → Contents: **Read and write**
- Metadata: **Read-only** (automatically included)

Do not put this token in `.env`, Astro code, GitHub Pages settings, or any `PUBLIC_` variable. It belongs only in the Cloudflare Worker secret store.

## 3. Configure and deploy the Worker

Install/login to Wrangler, then work from the `worker` directory:

```powershell
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

For `SESSION_SECRET`, enter a long random value of at least 32 characters.

Before deployment, update `worker/wrangler.jsonc`:

- Replace `REPLACE_WITH_NUMERIC_GITHUB_USER_ID` with the numeric `id` returned by `https://api.github.com/users/Lingyue-001`.
- If Wrangler assigns a different Worker URL, use that URL in the OAuth callback above.
- Keep `ALLOWED_ORIGIN` without a trailing slash.
- Keep `ADMIN_RETURN_URL` as the exact deployed editor URL, including the trailing slash.

After the first deploy, if the final Worker URL differs from the callback URL entered in GitHub, update the OAuth App and redeploy if necessary.

## 4. Connect the Astro site

Add this GitHub Actions repository variable:

- Name: `PUBLIC_ADMIN_API_URL`
- Value: `https://YOUR-WORKER.workers.dev`

Expose it to the Astro build in `.github/workflows/deploy.yml` under the build job:

```yaml
env:
  PUBLIC_ADMIN_API_URL: ${{ vars.PUBLIC_ADMIN_API_URL }}
```

For local development, copy `.example.env` to `.env` and set the same URL. `.env` stays ignored by Git.

## 5. Use the editor

1. Open `https://lingyue-001.github.io/cv/admin/` directly or from a bookmark.
2. Sign in with the authorised GitHub account.
3. Create a Note or Project, preview it, and publish.
4. Return to the public site. The owner toolbar remains visible in this browser for up to 12 hours.
5. Use **Log out** to remove the local management session immediately.

The editor route itself is public static HTML because GitHub Pages cannot protect individual paths. Its form stays locked until the Worker authenticates you, and all GitHub reads/writes are enforced by the Worker. To prevent even the editor shell from loading for visitors, put the site behind a custom domain and Cloudflare Access.
