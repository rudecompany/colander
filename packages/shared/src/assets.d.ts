// Bundled image assets resolve to their URL (Vite handles them in both apps and in tests).
declare module '*.webp' {
	const src: string;
	export default src;
}
