require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { HttpsProxyAgent } = require('https-proxy-agent');
const randomUseragent = require('random-useragent');

const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    white: "\x1b[37m",
    bold: "\x1b[1m",
};

function logPrefix(id) {
    return `${colors.bold}${colors.magenta}[Account ${id}]${colors.reset}`;
}

const logger = {
    info: (msg, id) => console.log(`${logPrefix(id)} ${colors.cyan}[i] ${msg}${colors.reset}`),
    warn: (msg, id) => console.log(`${logPrefix(id)} ${colors.yellow}[⚠] ${msg}${colors.reset}`),
    error: (msg, id) => console.log(`${logPrefix(id)} ${colors.red}[✗] ${msg}${colors.reset}`),
    success: (msg, id) => console.log(`${logPrefix(id)} ${colors.green}[✅] ${msg}${colors.reset}`),
    loading: (msg, id) => console.log(`${logPrefix(id)} ${colors.cyan}[⟳] ${msg}${colors.reset}`),
    step: (msg, id) => console.log(`${logPrefix(id)} ${colors.white}[➤] ${msg}${colors.reset}`),
    point: (msg, id) => console.log(`${logPrefix(id)} ${colors.white}[💰] ${msg}${colors.reset}`),
    proxy: (msg, id) => console.log(`${logPrefix(id)} ${colors.yellow}[🌐] ${msg}${colors.reset}`),
    banner: (id) => {
        console.log(`${colors.cyan}${colors.bold}`);
        console.log(`---------------------------------------------`);
        console.log(`   Titan Node Auto Bot - Airdrop Insiders   `);
        console.log(`---------------------------------------------${colors.reset}`);
        console.log(`${logPrefix(id)} Starting bot...`);
    },
};

function readTokens() {
    const tokensFilePath = path.join(__dirname, 'tokens.txt');
    try {
        return fs.readFileSync(tokensFilePath, 'utf-8')
            .split('\n')
            .map(t => t.trim())
            .filter(t => t);
    } catch (error) {
        console.error(`[✗] Error reading tokens.txt: ${error.message}`);
        return [];
    }
}

function readProxies() {
    const proxyFilePath = path.join(__dirname, 'proxies.txt');
    try {
        return fs.readFileSync(proxyFilePath, 'utf-8')
            .split('\n')
            .map(p => p.trim())
            .filter(p => p);
    } catch (error) {
        return [];
    }
}

class TitanNode {
    constructor(refreshToken, proxy = null, accountNumber = 1) {
        this.refreshToken = refreshToken;
        this.proxy = proxy;
        this.accountNumber = accountNumber;
        this.accessToken = null;
        this.userId = null;
        this.deviceId = uuidv4();

        const agent = this.proxy ? new HttpsProxyAgent(this.proxy) : null;

        this.api = axios.create({
            httpsAgent: agent,
            headers: {
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/json',
                'User-Agent': randomUseragent.getRandom(),
            }
        });

        this.ws = null;
        this.reconnectInterval = 1000 * 60 * 5;
        this.pingInterval = null;
    }

    async refreshAccessToken() {
        logger.loading('Attempting to refresh access token...', this.accountNumber);
        try {
            const response = await this.api.post('https://task.titannet.info/api/auth/refresh-token', {
                refresh_token: this.refreshToken,
            });

            if (response.data && response.data.code === 0) {
                this.accessToken = response.data.data.access_token;
                this.userId = response.data.data.user_id;
                this.api.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`;
                logger.success(`Access token refreshed. UserID: ${this.userId}`, this.accountNumber);
                return true;
            } else {
                logger.error(`Failed to refresh token: ${response.data.msg || 'Unknown error'}`, this.accountNumber);
                return false;
            }
        } catch (error) {
            logger.error(`Error refreshing access token: ${error.message}`, this.accountNumber);
            return false;
        }
    }

    async registerNode() {
        logger.loading('Registering node...', this.accountNumber);
        try {
            const payload = {
                ext_version: "0.0.4",
                language: "en",
                user_script_enabled: true,
                device_id: this.deviceId,
                install_time: new Date().toISOString(),
            };
            const response = await this.api.post('https://task.titannet.info/api/webnodes/register', payload);

            if (response.data && response.data.code === 0) {
                logger.success('Node registered successfully.', this.accountNumber);
                logger.info(`Initial Points: ${JSON.stringify(response.data.data)}`, this.accountNumber);
            } else {
                logger.error(`Node registration failed: ${response.data.msg || 'Unknown error'}`, this.accountNumber);
            }
        } catch (error) {
            logger.error(`Error registering node: ${error.message}`, this.accountNumber);
        }
    }

    connectWebSocket() {
        logger.loading('Connecting to WebSocket...', this.accountNumber);
        const wsUrl = `wss://task.titannet.info/api/public/webnodes/ws?token=${this.accessToken}&device_id=${this.deviceId}`;
        const agent = this.proxy ? new HttpsProxyAgent(this.proxy) : null;

        this.ws = new WebSocket(wsUrl, {
            agent: agent,
            headers: {
                'User-Agent': this.api.defaults.headers['User-Agent'],
            }
        });

        this.ws.on('open', () => {
            logger.success('WebSocket connection established. Waiting for jobs...', this.accountNumber);
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    const echoMessage = JSON.stringify({ cmd: 1, echo: "echo me", jobReport: { cfgcnt: 2, jobcnt: 0 } });
                    this.ws.send(echoMessage);
                }
            }, 30000);
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                if (message.cmd === 1) {
                    this.ws.send(JSON.stringify({ cmd: 2, echo: message.echo }));
                }
                if (message.userDataUpdate) {
                    logger.point(`Points Update - Today: ${message.userDataUpdate.today_points}, Total: ${message.userDataUpdate.total_points}`, this.accountNumber);
                }
            } catch {
                logger.warn(`Could not parse WebSocket message.`, this.accountNumber);
            }
        });

        this.ws.on('error', (error) => {
            logger.error(`WebSocket error: ${error.message}`, this.accountNumber);
            this.ws.close();
        });

        this.ws.on('close', () => {
            logger.warn('WebSocket closed. Reconnecting in 5 minutes...', this.accountNumber);
            clearInterval(this.pingInterval);
            setTimeout(() => this.start(), this.reconnectInterval);
        });
    }

    async start() {
        logger.banner(this.accountNumber);
        if (this.proxy) {
            logger.proxy(`Using Proxy: ${this.proxy}`, this.accountNumber);
        } else {
            logger.proxy(`Running in Direct Mode (No Proxy)`, this.accountNumber);
        }
        logger.step(`Device ID: ${this.deviceId}`, this.accountNumber);

        const ok = await this.refreshAccessToken();
        if (ok) {
            await this.registerNode();
            this.connectWebSocket();
        } else {
            logger.error('Bot failed to start due to token issue.', this.accountNumber);
        }
    }
}

function main() {
    const tokens = readTokens();
    const proxies = readProxies();

    if (tokens.length === 0) {
        console.error('[✗] No tokens found in tokens.txt');
        return;
    }

    tokens.forEach((token, index) => {
        const proxy = proxies[index % proxies.length] || null;
        const accountNumber = index + 1;
        setTimeout(() => {
            const bot = new TitanNode(token, proxy, accountNumber);
            bot.start();
        }, index * 5000);
    });
}

main();
