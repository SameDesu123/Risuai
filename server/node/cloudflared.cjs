const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync, createWriteStream } = require('fs');
const fs = require('fs/promises');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const binDir = path.join(process.cwd(), 'server', 'node', 'bin');
const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const downloadedBinPath = path.join(binDir, binName);
const releaseBaseURL = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const quickTunnelRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const connectedRegex = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;
const MAX_LOG_LINES = 200;

let configPath = '';
let config = {
    mode: 'quick',
    token: '',
};

let origin = {
    port: 6001,
    https: false,
};

const state = {
    status: 'stopped', // stopped | downloading | starting | running | error
    url: '',
    error: '',
    mode: '',
    binaryPath: '',
    logs: [],
};

let child = null;
let stopRequested = false;

function pushLog(line) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
        return;
    }
    state.logs.push(trimmed);
    if (state.logs.length > MAX_LOG_LINES) {
        state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
    }
}

function loadConfig() {
    if (!existsSync(configPath)) {
        return;
    }
    try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
        config = {
            mode: parsed.mode === 'token' ? 'token' : 'quick',
            token: typeof parsed.token === 'string' ? parsed.token : '',
        };
    } catch (error) {
        console.error('[Cloudflared] Failed to read config:', error.message);
    }
}

function saveConfig() {
    writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

function getReleaseAsset() {
    const archMap = {
        x64: 'amd64',
        arm64: 'arm64',
        arm: 'arm',
        ia32: '386',
    };
    const arch = archMap[process.arch];
    switch (process.platform) {
        case 'linux':
            return arch ? { name: `cloudflared-linux-${arch}`, archive: false } : null;
        case 'win32':
            // No native arm64 build; Windows on ARM runs the amd64 build under emulation
            return { name: `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe`, archive: false };
        case 'darwin':
            return (arch === 'amd64' || arch === 'arm64') ? { name: `cloudflared-darwin-${arch}.tgz`, archive: true } : null;
        default:
            return null;
    }
}

function isRunnable(binPath) {
    try {
        const result = spawnSync(binPath, ['--version'], { timeout: 10000, windowsHide: true });
        return result.status === 0;
    } catch {
        return false;
    }
}

function findBinary() {
    if (process.env.CLOUDFLARED_PATH && existsSync(process.env.CLOUDFLARED_PATH)) {
        return process.env.CLOUDFLARED_PATH;
    }
    if (existsSync(downloadedBinPath) && isRunnable(downloadedBinPath)) {
        return downloadedBinPath;
    }
    if (isRunnable('cloudflared')) {
        return 'cloudflared';
    }
    return '';
}

async function downloadBinary() {
    const asset = getReleaseAsset();
    if (!asset) {
        throw new Error(`No cloudflared release for ${process.platform}/${process.arch}. Install cloudflared manually or set CLOUDFLARED_PATH.`);
    }

    await fs.mkdir(binDir, { recursive: true });
    const tempPath = path.join(binDir, asset.name + '.download');
    pushLog(`[Risu] Downloading ${releaseBaseURL}/${asset.name}`);

    const response = await fetch(`${releaseBaseURL}/${asset.name}`);
    if (!response.ok || !response.body) {
        throw new Error(`Download failed with status ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));

    if (asset.archive) {
        await new Promise((resolve, reject) => {
            const tar = spawn('tar', ['-xzf', tempPath, '-C', binDir]);
            tar.on('error', reject);
            tar.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)));
        });
        await fs.rm(tempPath, { force: true });
    } else {
        await fs.rename(tempPath, downloadedBinPath);
    }

    if (process.platform !== 'win32') {
        await fs.chmod(downloadedBinPath, 0o755);
    }
    if (!isRunnable(downloadedBinPath)) {
        throw new Error('Downloaded cloudflared binary is not runnable');
    }
    pushLog('[Risu] Download complete');
    return downloadedBinPath;
}

function handleOutput(chunk) {
    for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        pushLog(line);
        if (!state.url) {
            const match = line.match(quickTunnelRegex);
            if (match && state.mode === 'quick') {
                state.url = match[0];
                console.log(`[Cloudflared] Tunnel URL: ${state.url}`);
            }
        }
        if (state.status === 'starting' && connectedRegex.test(line)) {
            state.status = 'running';
            console.log('[Cloudflared] Tunnel connected');
        }
    }
}

async function start() {
    if (child || state.status === 'downloading' || state.status === 'starting') {
        return;
    }
    const mode = config.mode;
    if (mode === 'token' && !config.token) {
        state.status = 'error';
        state.error = 'Tunnel token is not set';
        return;
    }

    stopRequested = false;
    state.mode = mode;
    state.url = '';
    state.error = '';
    state.logs = [];

    try {
        let binPath = findBinary();
        if (!binPath) {
            state.status = 'downloading';
            binPath = await downloadBinary();
        }
        if (stopRequested) {
            state.status = 'stopped';
            return;
        }
        state.binaryPath = binPath;
        state.status = 'starting';

        const env = { ...process.env };
        let args;
        if (mode === 'token') {
            // Pass the token through env so it doesn't show up in process listings
            env.TUNNEL_TOKEN = config.token;
            args = ['tunnel', '--no-autoupdate', 'run'];
        } else {
            const localURL = `${origin.https ? 'https' : 'http'}://127.0.0.1:${origin.port}`;
            args = ['tunnel', '--no-autoupdate', '--url', localURL];
            if (origin.https) {
                // Local certificate is usually self-signed
                args.push('--no-tls-verify');
            }
        }

        pushLog(`[Risu] Starting ${mode === 'token' ? 'named tunnel' : 'quick tunnel'}`);
        const proc = spawn(binPath, args, { env, windowsHide: true });
        child = proc;
        proc.stdout.on('data', handleOutput);
        proc.stderr.on('data', handleOutput);
        proc.on('error', (error) => {
            if (child === proc) {
                child = null;
            }
            state.status = 'error';
            state.error = error.message;
            pushLog(`[Risu] ${error.message}`);
        });
        proc.on('exit', (code, signal) => {
            if (child !== proc) {
                return;
            }
            child = null;
            state.url = '';
            pushLog(`[Risu] cloudflared exited (${signal ?? code})`);
            if (stopRequested) {
                state.status = 'stopped';
            } else if (state.status !== 'error') {
                state.status = 'error';
                state.error = `cloudflared exited unexpectedly (${signal ?? code})`;
            }
        });
    } catch (error) {
        child = null;
        state.status = 'error';
        state.error = error.message;
        pushLog(`[Risu] ${error.message}`);
        console.error('[Cloudflared] Failed to start:', error.message);
    }
}

function stop() {
    stopRequested = true;
    if (child) {
        child.kill();
        state.status = 'stopped';
        state.url = '';
    } else if (state.status !== 'downloading') {
        state.status = 'stopped';
        state.url = '';
    }
}

function getStatus() {
    return {
        status: state.status,
        url: state.url,
        error: state.error,
        mode: config.mode,
        runningMode: state.mode,
        hasToken: !!config.token,
        binaryPath: state.binaryPath,
        logs: state.logs,
    };
}

function registerCloudflaredRoutes(app, { checkAuth, limiter, savePath }) {
    configPath = path.join(savePath, '__cloudflared.json');
    loadConfig();

    app.get('/api/cloudflared/status', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        res.send(getStatus());
    });

    app.post('/api/cloudflared/config', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        const body = req.body ?? {};
        if (body.mode === 'quick' || body.mode === 'token') {
            config.mode = body.mode;
        }
        if (typeof body.token === 'string') {
            config.token = body.token.trim();
        }
        saveConfig();
        res.send(getStatus());
    });

    app.post('/api/cloudflared/start', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        // Not awaited: downloading can take a while, the client polls status
        start();
        res.send(getStatus());
    });

    app.post('/api/cloudflared/stop', limiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        stop();
        res.send(getStatus());
    });

    const killChild = () => {
        if (child) {
            stopRequested = true;
            child.kill();
        }
    };
    process.on('exit', killChild);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            killChild();
            process.exit(signal === 'SIGINT' ? 130 : 143);
        });
    }
}

function onServerListening({ port, https }) {
    origin = { port: Number(port), https };
}

module.exports = {
    registerCloudflaredRoutes,
    onServerListening,
};
