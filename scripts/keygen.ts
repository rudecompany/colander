// Makes a new Ed25519 signing key offline (contracts section 12). Run it on a trusted machine:
//
//   node scripts/keygen.ts <path>
//
// It writes the base64 of the 32-byte seed to <path> with mode 0600 and never overwrites a file.
// It prints the public key (base64 of the raw 32-byte key) and the key ID (hex of the first
// 8 bytes of SHA-256 over the public key), which is what lists, envelopes and plan tokens carry.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path || process.argv.length > 3) {
	console.error('Usage: node scripts/keygen.ts <path>');
	process.exit(2);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
if (seed.length !== 32 || pub.length !== 32) throw new Error('unexpected Ed25519 key size');

try {
	writeFileSync(path, seed.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
} catch (err) {
	if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
		console.error(`${path} already exists; refusing to overwrite a signing key.`);
		process.exit(1);
	}
	throw err;
}

console.log(`Wrote signing key to ${path}`);
console.log(`Public key: ${pub.toString('base64')}`);
console.log(`Key ID:     ${createHash('sha256').update(pub).digest().subarray(0, 8).toString('hex')}`);
