import { startWorker } from '../background/worker';

export default defineBackground({
	type: 'module',
	main() {
		startWorker();
	}
});
