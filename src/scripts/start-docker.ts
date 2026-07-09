import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as net from 'net';
import * as path from 'path';

async function main() {
    await waitForTcp(process.env.DB_HOST, parseInt(process.env.DB_PORT ?? '5432', 10), 'TimescaleDB');
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
    await waitForTcp(redisUrl.hostname, parseInt(redisUrl.port || '6379', 10), 'Redis');
    await run('node', ['dist/scripts/run-migrations.js']);
    await ensureTlsCerts();

    if (process.env.PM2_ENABLED === 'false') {
        await run('node', ['dist/main.js'], true);
        return;
    }

    await run('./node_modules/.bin/pm2-runtime', ['ecosystem.config.js'], true);
}

function waitForTcp(host: string, port: number, label: string): Promise<void> {
    const deadline = Date.now() + parseInt(process.env.STARTUP_WAIT_TIMEOUT_MS ?? '60000', 10);

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.createConnection({ host, port });
            socket.once('connect', () => {
                socket.destroy();
                console.log(`${label} is reachable at ${host}:${port}`);
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error(`${label} was not reachable at ${host}:${port}`));
                    return;
                }
                setTimeout(attempt, 1000);
            });
        };

        attempt();
    });
}

// Resolves the stratum TLS cert/key to use and, if none is configured, generates
// a self-signed pair so STRATUM_SECURE=true never depends on a manual step.
// Real certs at STRATUM_TLS_CERT_PATH/STRATUM_TLS_KEY_PATH (default secrets/) always
// take precedence; generated certs live in a separate writable directory because
// secrets/ is mounted read-only.
async function ensureTlsCerts(): Promise<void> {
    if (process.env.STRATUM_SECURE?.toLowerCase() !== 'true') {
        return;
    }

    const certPath = process.env.STRATUM_TLS_CERT_PATH ?? path.join(process.cwd(), 'secrets', 'cert.pem');
    const keyPath = process.env.STRATUM_TLS_KEY_PATH ?? path.join(process.cwd(), 'secrets', 'key.pem');

    if (existsSync(certPath) && existsSync(keyPath)) {
        console.log(`Stratum TLS: using certificate at ${certPath}`);
        process.env.STRATUM_TLS_CERT_PATH = certPath;
        process.env.STRATUM_TLS_KEY_PATH = keyPath;
        return;
    }

    const generatedDir = process.env.STRATUM_TLS_GENERATED_DIR ?? path.join(process.cwd(), 'secrets-generated');
    const generatedCertPath = path.join(generatedDir, 'cert.pem');
    const generatedKeyPath = path.join(generatedDir, 'key.pem');

    if (existsSync(generatedCertPath) && existsSync(generatedKeyPath)) {
        console.warn(`Stratum TLS: no certificate at ${certPath}; reusing previously generated self-signed certificate at ${generatedCertPath}. Place a real certificate at that path to override it.`);
        process.env.STRATUM_TLS_CERT_PATH = generatedCertPath;
        process.env.STRATUM_TLS_KEY_PATH = generatedKeyPath;
        return;
    }

    console.warn(`Stratum TLS: no certificate at ${certPath}; generating a self-signed certificate at ${generatedCertPath}. This encrypts stratum traffic but does not verify server identity — place a real certificate at that path to override it.`);
    mkdirSync(generatedDir, { recursive: true });
    await run('openssl', [
        'req', '-x509',
        '-newkey', 'rsa:2048',
        '-keyout', generatedKeyPath,
        '-out', generatedCertPath,
        '-days', '3650',
        '-nodes',
        '-subj', '/CN=public-pool-self-signed',
    ]);
    console.log(`Stratum TLS: generated self-signed certificate at ${generatedCertPath}`);
    process.env.STRATUM_TLS_CERT_PATH = generatedCertPath;
    process.env.STRATUM_TLS_KEY_PATH = generatedKeyPath;
}

function run(command: string, args: string[], inherit = false): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: inherit ? 'inherit' : 'pipe',
            env: process.env,
        });

        if (!inherit) {
            child.stdout?.on('data', data => process.stdout.write(data));
            child.stderr?.on('data', data => process.stderr.write(data));
        }

        child.once('exit', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
        });
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
