interface Env {
	ALLOWED_ORIGIN: string;
	ADMIN_RETURN_URL: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_TOKEN: string;
	OWNER_GITHUB_ID: string;
	REPO_OWNER: string;
	REPO_NAME: string;
	BRANCH?: string;
	SESSION_SECRET: string;
}

interface SessionClaims {
	login: string;
	uid: string;
	exp: number;
}
interface PublishInput {
	type: "note" | "post";
	slug: string;
	title: string;
	description?: string;
	publishDate: string;
	dateRange?: string;
	tags?: string[];
	projectUrl?: string;
	projectUrlText?: string;
	pinned?: boolean;
	draft?: boolean;
	body?: string;
	sha?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);
		const url = new URL(request.url);
		try {
			if (url.pathname === "/auth/github") return startLogin(url, env);
			if (url.pathname === "/auth/callback") return finishLogin(request, url, env);
			if (url.pathname === "/api/session" && request.method === "GET")
				return withCors(await sessionInfo(request, env), env);
			if (url.pathname === "/api/content" && request.method === "GET")
				return withCors(await readContent(request, url, env), env);
			if (url.pathname === "/api/publish" && request.method === "POST")
				return withCors(await publish(request, env), env);
			return withCors(json({ error: "Not found" }, 404), env);
		} catch (error) {
			console.error(error);
			return withCors(json({ error: "Unexpected server error" }, 500), env);
		}
	},
};

async function startLogin(url: URL, env: Env) {
	const returnTo = url.searchParams.get("return_to") ?? env.ADMIN_RETURN_URL;
	if (!returnTo.startsWith(env.ADMIN_RETURN_URL)) return json({ error: "Invalid return URL" }, 400);
	const nonce = crypto.randomUUID();
	const state = await sign(
		{ nonce, returnTo, exp: Math.floor(Date.now() / 1000) + 600 },
		env.SESSION_SECRET,
	);
	const github = new URL("https://github.com/login/oauth/authorize");
	github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	github.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
	github.searchParams.set("scope", "read:user");
	github.searchParams.set("state", state);
	return new Response(null, {
		status: 302,
		headers: {
			Location: github.toString(),
			"Set-Cookie": `oauth_state=${nonce}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
			"Cache-Control": "no-store",
		},
	});
}

async function finishLogin(request: Request, url: URL, env: Env) {
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) return htmlError("GitHub did not return an authorization code.", 400);
	const stateData = await verify<{ nonce: string; returnTo: string; exp: number }>(
		state,
		env.SESSION_SECRET,
	);
	const cookieNonce = readCookie(request.headers.get("Cookie"), "oauth_state");
	if (!stateData || stateData.exp < Date.now() / 1000 || stateData.nonce !== cookieNonce)
		return htmlError("The sign-in request expired. Please try again.", 401);

	const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "lingyue-cv-admin",
		},
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});
	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		error_description?: string;
	};
	if (!tokenData.access_token)
		return htmlError(tokenData.error_description ?? "GitHub sign-in failed.", 401);
	const userResponse = await fetch("https://api.github.com/user", {
		headers: githubHeaders(tokenData.access_token),
	});
	const user = (await userResponse.json()) as { id?: number; login?: string };
	if (!user.id || String(user.id) !== env.OWNER_GITHUB_ID || !user.login)
		return htmlError("This GitHub account is not authorised to edit the site.", 403);

	const session = await sign(
		{ login: user.login, uid: String(user.id), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12 },
		env.SESSION_SECRET,
	);
	const destination = new URL(stateData.returnTo);
	destination.hash = `admin_session=${encodeURIComponent(session)}`;
	return new Response(null, {
		status: 302,
		headers: {
			Location: destination.toString(),
			"Set-Cookie": "oauth_state=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
			"Cache-Control": "no-store",
		},
	});
}

async function sessionInfo(request: Request, env: Env) {
	const claims = await authorise(request, env);
	return claims ? json({ login: claims.login }) : json({ error: "Not authorised" }, 401);
}

async function readContent(request: Request, url: URL, env: Env) {
	if (!(await authorise(request, env))) return json({ error: "Not authorised" }, 401);
	const type = url.searchParams.get("type");
	const slug = url.searchParams.get("slug") ?? "";
	if ((type !== "note" && type !== "post") || !validSlug(slug))
		return json({ error: "Invalid content path" }, 400);
	const path = `src/content/${type}/${slug}.md`;
	const response = await githubApi(
		env,
		`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}?ref=${encodeURIComponent(env.BRANCH ?? "main")}`,
	);
	if (response.status === 404) return json({ error: "Document not found" }, 404);
	if (!response.ok) return githubError(response);
	const file = (await response.json()) as { content: string; sha: string };
	return json({ content: decodeBase64(file.content.replace(/\s/g, "")), sha: file.sha });
}

async function publish(request: Request, env: Env) {
	const claims = await authorise(request, env);
	if (!claims) return json({ error: "Not authorised" }, 401);
	let input: PublishInput;
	try {
		input = (await request.json()) as PublishInput;
	} catch {
		return json({ error: "Invalid JSON body" }, 400);
	}
	const validationError = validateInput(input);
	if (validationError) return json({ error: validationError }, 400);
	const path = `src/content/${input.type}/${input.slug}.md`;
	const content = buildMarkdown(input);
	const response = await githubApi(
		env,
		`/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`,
		{
			method: "PUT",
			body: JSON.stringify({
				message: `${input.sha ? "Update" : "Publish"} ${input.type}: ${input.title}`,
				content: encodeBase64(content),
				branch: env.BRANCH ?? "main",
				...(input.sha ? { sha: input.sha } : {}),
			}),
		},
	);
	if (response.status === 409 || response.status === 422)
		return json({ error: "The file changed or already exists. Reload it before publishing." }, 409);
	if (!response.ok) return githubError(response);
	const result = (await response.json()) as {
		content?: { sha?: string };
		commit?: { html_url?: string };
	};
	return json({
		sha: result.content?.sha,
		commitUrl: result.commit?.html_url,
		editor: claims.login,
	});
}

function validateInput(input: PublishInput) {
	if (input.type !== "note" && input.type !== "post") return "Invalid content type";
	if (!validSlug(input.slug))
		return "Slug must contain only lowercase letters, numbers and hyphens";
	if (!input.title?.trim() || input.title.trim().length > 60)
		return "Title must be between 1 and 60 characters";
	if (!input.publishDate || Number.isNaN(new Date(input.publishDate).valueOf()))
		return "Publish date is invalid";
	if (input.type === "post" && !input.description?.trim()) return "Projects require a description";
	if (input.projectUrl) {
		try {
			const url = new URL(input.projectUrl);
			if (!/^https?:$/.test(url.protocol)) return "Project URL must use http or https";
		} catch {
			return "Project URL is invalid";
		}
	}
	if (input.body && input.body.length > 200_000) return "Document is too large";
	return null;
}

function buildMarkdown(input: PublishInput) {
	const lines = ["---", `title: ${yaml(input.title.trim())}`];
	if (input.description?.trim()) lines.push(`description: ${yaml(input.description.trim())}`);
	lines.push(`publishDate: ${yaml(input.publishDate)}`);
	if (input.type === "post") {
		if (input.dateRange?.trim()) lines.push(`dateRange: ${yaml(input.dateRange.trim())}`);
		lines.push(
			`tags: ${JSON.stringify((input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))}`,
		);
		lines.push(`pinned: ${Boolean(input.pinned)}`, `draft: ${Boolean(input.draft)}`);
		if (input.projectUrl?.trim()) lines.push(`projectUrl: ${yaml(input.projectUrl.trim())}`);
		if (input.projectUrlText?.trim())
			lines.push(`projectUrlText: ${yaml(input.projectUrlText.trim())}`);
	}
	return `${lines.join("\n")}\n---\n\n${(input.body ?? "").trim()}\n`;
}

async function authorise(request: Request, env: Env): Promise<SessionClaims | null> {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const claims = await verify<SessionClaims>(header.slice(7), env.SESSION_SECRET);
	if (!claims || claims.exp < Date.now() / 1000 || claims.uid !== env.OWNER_GITHUB_ID) return null;
	return claims;
}

async function sign(payload: object, secret: string) {
	const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
	return `${encoded}.${base64Url(new Uint8Array(signature))}`;
}

async function verify<T>(value: string, secret: string): Promise<T | null> {
	const [encoded, signature] = value.split(".");
	if (!encoded || !signature) return null;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			fromBase64Url(signature),
			encoder.encode(encoded),
		);
		return valid ? (JSON.parse(decoder.decode(fromBase64Url(encoded))) as T) : null;
	} catch {
		return null;
	}
}

function githubApi(env: Env, path: string, init: RequestInit = {}) {
	return fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			...githubHeaders(env.GITHUB_TOKEN),
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
}
function githubHeaders(token: string) {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "lingyue-cv-admin",
	};
}
async function githubError(response: Response) {
	const detail = (await response.json().catch(() => ({}))) as { message?: string };
	return json({ error: detail.message ?? "GitHub request failed" }, response.status);
}
function validSlug(slug: string) {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;
}
function yaml(value: string) {
	return JSON.stringify(value);
}
function readCookie(header: string | null, name: string) {
	return header
		?.split(";")
		.map((item) => item.trim())
		.find((item) => item.startsWith(`${name}=`))
		?.slice(name.length + 1);
}
function base64Url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
function fromBase64Url(value: string) {
	const base64 = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
function encodeBase64(value: string) {
	return btoa(String.fromCharCode(...encoder.encode(value)));
}
function decodeBase64(value: string) {
	return decoder.decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
function withCors(response: Response, env: Env) {
	return cors(response, env);
}
function cors(response: Response, env: Env) {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
	headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	headers.set("Vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
function htmlError(message: string, status: number) {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>${message.replace(/[&<>]/g, "")}</p>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}
