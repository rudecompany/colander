// The registry's entries (seed-registry.json, validated by seeds.ts). Only the Worker, the
// prerendered /credits page and tests import this: a public page or the extension that bundled it
// would name every dataset.
import data from './seed-registry.json';
import type { Registry, SeedEntry } from './seeds';

export const REGISTRY: readonly SeedEntry[] = (data as Registry).entries;
