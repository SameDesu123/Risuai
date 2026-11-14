// Built-in cloudflared (Cloudflare Quick Tunnel) manager for the Node server.
//
// Nothing here runs on its own: the binary is only downloaded when the user
// presses the install button, and the tunnel is only started when the user
// presses the start button after accepting the Quick Tunnel terms. The running
// state is never persisted, so a server restart always leaves the tunnel off.

const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { existsSync, createWriteStream } = require('fs');
const fs = require('fs/promises');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const RELEASE_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const RELEASE_LATEST_PAGE = 'https://github.com/cloudflare/cloudflared/releases/latest';
const LATEST_CACHE_MS = 10 * 60 * 1000;
const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MAX_LOG_LINES = 200;

const binDir = path.join(process.cwd(), 'bin');
const binPath = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const state = {
    // 'idle' | 'downloading' | 'starting' | 'running' | 'stopping'
    phase: 'idle',
    process: null,
    url: '',
    error: '',
    logs: [],
    version: '',
    latest: { version: '', checkedAt: 0 },
};

// "cloudflared version 2026.11.0 (built ...)" -> "2026.11.0"
function shortVersion(full) {
    const match = String(full || '').match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : '';
}

// Resolves the latest release tag by following GitHub's /releases/latest redirect.
async function getLatestVersion(force = false) {
    if (!force && state.latest.version && Date.now() - state.latest.checkedAt < LATEST_CACHE_MS) {
        return state.latest.version;
    }
    const res = await fetch(RELEASE_LATEST_PAGE, { redirect: 'manual', headers: { 'user-agent': 'risuai-node-server' } });
    const location = res.headers.get('location') || '';
    const version = shortVersion(location.split('/tag/')[1]);
    if (!version) {
        throw new Error(`Could not resolve the latest cloudflared version (${res.status})`);
    }
    state.latest = { version, checkedAt: Date.now() };
    return version;
}

function pushLog(line) {
    const trimmed = String(line).trimEnd();
    if (!trimmed) {
        return;
    }
    state.logs.push(trimmed);
    if (state.logs.length > MAX_LOG_LINES) {
        state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
    }
}

function getAssetName() {
    const { platform, arch } = process;
    if (platform === 'win32') {
        if (arch === 'x64') return 'cloudflared-windows-amd64.exe';
        if (arch === 'arm64') return 'cloudflared-windows-arm64.exe';
        if (arch === 'ia32') return 'cloudflared-windows-386.exe';
    }
    if (platform === 'linux') {
        if (arch === 'x64') return 'cloudflared-linux-amd64';
        if (arch === 'arm64') return 'cloudflared-linux-arm64';
        if (arch === 'arm') return 'cloudflared-linux-arm';
        if (arch === 'ia32') return 'cloudflared-linux-386';
    }
    if (platform === 'darwin') {
        if (arch === 'x64') return 'cloudflared-darwin-amd64.tgz';
        if (arch === 'arm64') return 'cloudflared-darwin-arm64.tgz';
    }
    return null;
}

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 30000, ...options }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

async function readInstalledVersion() {
    if (!existsSync(binPath)) {
        state.version = '';
        return '';
    }
    try {
        const { stdout } = await execFileAsync(binPath, ['--version']);
        state.version = stdout.trim();
    } catch {
        state.version = '';
    }
    return state.version;
}

// Looks up the expected SHA-256 from the GitHub release metadata, if available.
async function getExpectedDigest(assetName) {
    try {
        const res = await fetch(RELEASE_API, {
            headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'risuai-node-server' },
        });
        if (!res.ok) {
            return null;
        }
        const release = await res.json();
        const asset = (release.assets || []).find((a) => a.name === assetName);
        if (!asset || typeof asset.digest !== 'string' || !asset.digest.startsWith('sha256:')) {
            return null;
        }
        return { digest: asset.digest.slice('sha256:'.length).toLowerCase(), url: asset.browser_download_url, tag: release.tag_name };
    } catch {
        return null;
    }
}

async function downloadBinary() {
    const assetName = getAssetName();
    if (!assetName) {
        throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
    }

    await fs.mkdir(binDir, { recursive: true });
    const expected = await getExpectedDigest(assetName);
    const downloadUrl = expected?.url || (RELEASE_DOWNLOAD + assetName);
    pushLog(`[Risu] Downloading ${assetName}${expected?.tag ? ` (${expected.tag})` : ''}...`);

    const res = await fetch(downloadUrl, { headers: { 'user-agent': 'risuai-node-server' } });
    if (!res.ok || !res.body) {
        throw new Error(`Download failed (${res.status})`);
    }

    const tmpPath = path.join(binDir, `${assetName}.download`);
    const hash = crypto.createHash('sha256');
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => hash.update(chunk));
    await pipeline(source, createWriteStream(tmpPath));

    const actualDigest = hash.digest('hex');
    if (expected?.digest) {
        if (expected.digest !== actualDigest) {
            await fs.rm(tmpPath, { force: true });
            throw new Error('Checksum mismatch, downloaded file was discarded');
        }
        pushLog('[Risu] SHA-256 checksum verified.');
    } else {
        pushLog(`[Risu] Could not fetch the release checksum; SHA-256 of download is ${actualDigest}`);
    }

    if (assetName.endsWith('.tgz')) {
        await execFileAsync('tar', ['-xzf', tmpPath, '-C', binDir]);
        await fs.rm(tmpPath, { force: true });
    } else {
        await fs.rm(binPath, { force: true });
        await fs.rename(tmpPath, binPath);
    }

    if (process.platform !== 'win32') {
        await fs.chmod(binPath, 0o755);
    }
    await readInstalledVersion();
    pushLog(`[Risu] Installed ${state.version || 'cloudflared'}.`);
}

function startTunnel(originUrl) {
    const args = ['tunnel', '--no-autoupdate', '--url', originUrl];
    if (originUrl.startsWith('https://')) {
        // The local server may be using a self-signed certificate.
        args.push('--no-tls-verify');
    }

    state.url = '';
    state.error = '';
    state.phase = 'starting';
    pushLog(`[Risu] Starting: cloudflared ${args.join(' ')}`);

    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    state.process = child;

    const onData = (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
            pushLog(line);
            const match = line.match(TRYCLOUDFLARE_URL_REGEX);
            if (match && !state.url) {
                state.url = match[0];
                state.phase = 'running';
                console.log(`[Server] Cloudflare Quick Tunnel is up: ${state.url}`);
            }
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
        state.error = err.message;
        pushLog(`[Risu] Failed to start cloudflared: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
        if (state.process === child) {
            state.process = null;
            if (state.phase !== 'stopping' && !state.error && code !== 0) {
                state.error = `cloudflared exited (${signal || code})`;
            }
            state.phase = 'idle';
            state.url = '';
        }
        pushLog(`[Risu] cloudflared exited (${signal || code}).`);
    });
}

function stopTunnel() {
    if (!state.process) {
        return;
    }
    state.phase = 'stopping';
    try {
        state.process.kill();
    } catch {}
}

function getStatus() {
    return {
        supported: !!getAssetName(),
        platform: `${process.platform}/${process.arch}`,
        installed: existsSync(binPath),
        version: state.version,
        installedVersion: shortVersion(state.version),
        phase: state.phase,
        running: !!state.process,
        url: state.url,
        error: state.error,
        logs: state.logs.slice(-50),
    };
}

/**
 * @param {import('express').Express} app
 * @param {{ checkAuth: Function, limiter: Function, getOriginUrl: () => string }} deps
 */
function registerCloudflaredRoutes(app, { checkAuth, limiter, getOriginUrl }) {
    readInstalledVersion();

    app.get('/api/cloudflared/status', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        res.send(getStatus());
    });

    app.get('/api/cloudflared/latest', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        try {
            const latest = await getLatestVersion(req.query.force === '1');
            res.send({ latest });
        } catch (error) {
            res.status(502).send({ error: error.message });
        }
    });

    app.post('/api/cloudflared/install', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (state.process) {
            res.status(409).send({ error: 'Stop the tunnel before reinstalling' });
            return;
        }
        if (state.phase === 'downloading') {
            res.status(409).send({ error: 'Download already in progress' });
            return;
        }
        state.phase = 'downloading';
        state.error = '';
        try {
            await downloadBinary();
            state.phase = 'idle';
            state.latest.checkedAt = 0;
            res.send(getStatus());
        } catch (error) {
            state.phase = 'idle';
            state.error = error.message;
            pushLog(`[Risu] Install failed: ${error.message}`);
            res.status(500).send({ ...getStatus(), error: error.message });
        }
    });

    app.post('/api/cloudflared/start', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        // The user must have explicitly accepted the Quick Tunnel terms in the UI.
        if (req.body?.acceptTerms !== true) {
            res.status(400).send({ error: 'Quick Tunnel terms must be accepted first' });
            return;
        }
        if (!existsSync(binPath)) {
            res.status(400).send({ error: 'cloudflared is not installed' });
            return;
        }
        if (state.process || state.phase === 'downloading') {
            res.status(409).send({ error: 'cloudflared is busy' });
            return;
        }
        startTunnel(getOriginUrl());
        res.send(getStatus());
    });

    app.post('/api/cloudflared/stop', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        stopTunnel();
        res.send(getStatus());
    });

    app.post('/api/cloudflared/uninstall', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (state.process) {
            res.status(409).send({ error: 'Stop the tunnel before uninstalling' });
            return;
        }
        await fs.rm(binPath, { force: true });
        state.version = '';
        pushLog('[Risu] cloudflared binary removed.');
        res.send(getStatus());
    });

    // Never leave an orphaned tunnel behind when the server goes down.
    const killOnExit = () => {
        if (state.process) {
            try { state.process.kill(); } catch {}
        }
    };
    process.on('exit', killOnExit);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            killOnExit();
            process.exit(0);
        });
    }
}

module.exports = { registerCloudflaredRoutes };
