// Isolated-world content script. Registered at runtime (browser.scripting) only for the
// platforms the user switched on and granted, and runs at document_start.
import './host.css';
import { start } from '../../content/page';

export default defineContentScript({
	matches: ['*://*.youtube.com/*'],
	registration: 'runtime',
	runAt: 'document_start',
	main() {
		start();
	}
});
