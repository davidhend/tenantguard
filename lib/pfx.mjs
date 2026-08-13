// Converts an uploaded .pfx / .p12 bundle to the PEM certificate + private
// key the auth layer uses. Node has no built-in PKCS#12 parser, so this
// shells out to the openssl CLI (present on virtually every Linux host; the
// Dockerfile installs it). The password travels via an env var — never on
// the command line — and the bundle touches disk only as a 0600 temp file
// that is removed immediately.
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runOpenssl(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openssl', args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject); // openssl binary missing
    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `openssl exited with code ${code}`));
    });
  });
}

// openssl prefixes PEM output with "Bag Attributes" lines — take just the block.
function extractPem(text, label) {
  const m = text.match(new RegExp(`-----BEGIN [A-Z0-9 ]*${label}-----[\\s\\S]*?-----END [A-Z0-9 ]*${label}-----`));
  return m?.[0] ?? null;
}

export async function pfxToPem(pfxBuffer, password = '') {
  try {
    await runOpenssl(['version']);
  } catch {
    throw new Error('Importing .pfx files requires the openssl CLI on the server (apt install openssl / apk add openssl). Alternatively paste PEM values directly.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'tenantguard-'));
  const file = join(dir, 'import.pfx');
  try {
    await writeFile(file, pfxBuffer, { mode: 0o600 });
    const env = { TG_PFX_PASS: password };
    const extract = async (args) => {
      // OpenSSL 3 dropped legacy PFX ciphers (RC2/3DES from older Windows
      // exports) from the default provider — retry with -legacy before failing.
      try { return await runOpenssl(args, env); }
      catch (err) {
        try { return await runOpenssl([...args, '-legacy'], env); }
        catch { throw err; }
      }
    };
    const keyOut = await extract(['pkcs12', '-in', file, '-nocerts', '-nodes', '-passin', 'env:TG_PFX_PASS']);
    const certOut = await extract(['pkcs12', '-in', file, '-clcerts', '-nokeys', '-passin', 'env:TG_PFX_PASS']);
    const privateKey = extractPem(keyOut, 'PRIVATE KEY');
    const certificate = extractPem(certOut, 'CERTIFICATE');
    if (!privateKey) throw new Error('No private key found in the .pfx — is the password correct?');
    if (!certificate) throw new Error('No certificate found in the .pfx');
    return { certificate, privateKey };
  } catch (err) {
    if (/invalid password|mac verify/i.test(err.message)) throw new Error('Wrong .pfx password');
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
