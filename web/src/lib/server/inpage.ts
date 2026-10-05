// Prerender only: the shared in-page builders need a document, so linkedom gives them one and
// InPage serializes what they build as Declarative Shadow DOM. Never shipped to the browser.
import { parseHTML } from 'linkedom';
import { setServerDocument } from '@colander/shared/inpage';

setServerDocument(() => parseHTML('<!doctype html><html><body></body></html>').document as unknown as Document);
