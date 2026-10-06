// Writes api/wrangler.dev.json for local runs: api/wrangler.jsonc without its routes and named
// environments. With routes, `wrangler dev` rewrites every request's host to the first route's
// (getcolander.com), so the Worker could not tell the admin host (admin.localhost) from the site
// (localhost). It also declares OPS_TOKEN, the dev ops token of api/.dev.vars, which no deployed
// environment has: Wrangler loads only declared secrets. `pnpm -C api dev` and the e2e stack run
// it; deploys always use wrangler.jsonc.
import { writeFileSync } from 'node:fs';
import { experimental_readRawConfig } from 'wrangler';

const api = new URL('../api/', import.meta.url).pathname;
const { rawConfig } = experimental_readRawConfig({ config: `${api}wrangler.jsonc` });
const { routes: _routes, env: _env, ...dev } = rawConfig as Record<string, unknown> & { secrets?: { required?: string[] } };
const secrets = { required: [...(dev.secrets?.required ?? []), 'OPS_TOKEN'] };
writeFileSync(`${api}wrangler.dev.json`, JSON.stringify({ ...dev, secrets, $schema: './node_modules/wrangler/config-schema.json' }, null, '\t') + '\n');
