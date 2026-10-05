// /credits names the datasets whose license asks for credit, and only those (docs/contracts.md
// 14.3). It prerenders from the seed registry at build time; the registry itself never reaches a
// page's JavaScript, so no other page can name a dataset.
import { REGISTRY } from '@colander/shared/seed-registry';
import { credits } from '@colander/shared/seeds';

export const load = () => ({ credits: credits(REGISTRY) });
