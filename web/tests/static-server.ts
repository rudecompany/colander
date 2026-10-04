// Serves build/ with the lookup web/README.md asks of a host: a file, then {path}.html, then
// {path}/index.html, then the SPA fallback 200.html. The API is mocked per test with page.route.
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
	const found = file(base) ?? file(base + '.html') ?? file(join(base, 'index.html')) ?? join(root, '200.html');
	res.writeHead(200, { 'Content-Type': types[extname(found)] ?? 'application/octet-stream' });
	createReadStream(found).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
