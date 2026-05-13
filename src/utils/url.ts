export function withBase(path: string) {
	if (/^(?:[a-z]+:)?\/\//i.test(path) || /^(?:mailto|tel):/i.test(path) || path.startsWith("#")) {
		return path;
	}

	const base = import.meta.env.BASE_URL;
	const normalizedBase = base.endsWith("/") ? base : `${base}/`;
	const normalizedPath = path.replace(/^\/+/, "");

	if (path === "/" || path === "") return normalizedBase;
	if (path === normalizedBase && normalizedPath) return `${normalizedBase}${normalizedPath}`;
	if (path.startsWith(normalizedBase)) return path;

	return `${normalizedBase}${normalizedPath}`;
}
