// Serves build/ with the lookup web/README.md asks of a host, as Workers Static Assets does: a file,
// then {path}.html, then {path}/index.html. The client-rendered routes (/s/{platform}/{id},
// /appeal/{platform}/{id}, /appeal/status/{id}) get the SPA fallback 200.html; any other path is a
// real 404 with 404.html, a copy of the same shell, which renders the not-found page. The API is
// mocked per test with page.route.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..', 'build');
const port = Number(process.env.PORT ?? 4173);
const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.json': 'application/json'
};

function file(path: string): string | null {
	try {
		return statSync(path).isFile() ? path : null;
	} catch {
		return null;
	}
}

createServer((req, res) => {
	const pathname = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
	if (pathname.startsWith('/v1/')) {
		res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":{"code":"unmocked","message":"Not mocked."}}');
		return;
	}
	const base = join(root, pathname);
	const spa = /^\/(s\/(yt|tt|ig|fb)|appeal\/(yt|tt|ig|fb|status))\/[^/]+$/.test(pathname);
	// The shells are not pages of their own: /200 and /404 are not found, as on the Worker.
	const shell = pathname === '/200' || pathname === '/404';
	const page = shell ? null : (file(base) ?? file(base + '.html') ?? file(join(base, 'index.html')) ?? (spa ? join(root, '200.html') : null));
	const found = page ?? file(join(root, '404.html')) ?? join(root, '200.html');
	res.writeHead(page ? 200 : 404, { 'Content-Type': types[extname(found)] ?? 'application/octet-stream' });
	createReadStream(found).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
