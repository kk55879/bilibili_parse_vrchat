const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const geoip = require('geoip-lite');

const app = express();

const PORT = process.env.PORT || 3000;

// 服務計數器
let serviceCounters = {
    total: 0,
    today: 0,
    thisMonth: 0,
    lastResetDate: new Date().toDateString(),
    lastResetMonth: new Date().getMonth()
};

// 中間件
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// 配置 Express 來獲取真實 IP 地址
app.set('trust proxy', true);

// 強制瀏覽器與 VRChat 播放器不快取
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

function getLocationInfo(ip) {
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
        return '本地網路';
    }
    const geo = geoip.lookup(ip);
    if (geo) {
        return `${geo.country} ${geo.city || geo.region || ''}`.trim();
    }
    return '未知位置';
}

function updateCounters() {
    const now = new Date();
    const today = now.toDateString();
    const thisMonth = now.getMonth();
    
    if (serviceCounters.lastResetDate !== today) {
        serviceCounters.today = 0;
        serviceCounters.lastResetDate = today;
    }
    if (serviceCounters.lastResetMonth !== thisMonth) {
        serviceCounters.thisMonth = 0;
        serviceCounters.lastResetMonth = thisMonth;
    }
    
    serviceCounters.total++;
    serviceCounters.today++;
    serviceCounters.thisMonth++;
    
    return {
        total: serviceCounters.total,
        today: serviceCounters.today,
        thisMonth: serviceCounters.thisMonth
    };
}

function getCounters() {
    const now = new Date();
    const today = now.toDateString();
    const thisMonth = now.getMonth();
    
    if (serviceCounters.lastResetDate !== today) {
        serviceCounters.today = 0;
        serviceCounters.lastResetDate = today;
    }
    if (serviceCounters.lastResetMonth !== thisMonth) {
        serviceCounters.thisMonth = 0;
        serviceCounters.lastResetMonth = thisMonth;
    }
    
    return {
        total: serviceCounters.total,
        today: serviceCounters.today,
        thisMonth: serviceCounters.thisMonth
    };
}

async function resolveB23ShortLink(shortUrl) {
    try {
        let url = shortUrl;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        
        const response = await axios.get(url, {
            maxRedirects: 5,
            validateStatus: (status) => status < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            },
            maxContentLength: 1024 * 1024,
            timeout: 5000
        });
        
        const finalUrl = response.request?.res?.responseUrl || 
                        response.request?.res?.response?.headers?.location ||
                        response.config?.url ||
                        url;
        return finalUrl;
    } catch (error) {
        if (error.response && error.response.headers && error.response.headers.location) {
            return error.response.headers.location;
        }
        console.error(`❌ 解析 b23.tv 短連結失敗: ${shortUrl}`, error.message);
        return null;
    }
}

const nodeStatus = {
    'upos-sz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '深圳' },
    'upos-bj-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '北京' },
    'upos-hz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '杭州' },
    'upos-sz-mirror08c.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: 'Mirror', isMirror: true }
};

async function checkNodeAvailability(node, bvid) {
    try {
        const testUrl = `https://${node}/upgcxcode/00/44/1234567890/${bvid}/1-64.flv?deadline=1234567890&gen=playurl&nbs=1&oi=1234567890&os=upos-sz&platform=pc&trid=1234567890&uipk=5&upsig=1234567890&uparams=,C0,E0&mid=0&orderid=0,3&agrr=0&logo=80000000`;
        const response = await axios.head(testUrl, { 
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            }
        });
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

async function getBestAvailableNode(bvid) {
    const mainNodes = Object.keys(nodeStatus).filter(node => !nodeStatus[node].isMirror);
    const sortedNodes = mainNodes.sort((a, b) => {
        const aStatus = nodeStatus[a];
        const bStatus = nodeStatus[b];
        const aRate = aStatus.successCount / (aStatus.successCount + aStatus.failCount || 1);
        const bRate = bStatus.successCount / (bStatus.successCount + bStatus.failCount || 1);
        return bRate - aRate;
    });
    const bestNode = sortedNodes[0];
    console.log(`🎯 選擇節點: ${bestNode} (${nodeStatus[bestNode].region})`);
    return bestNode;
}

function getRandomMainNode() {
    const mainNodes = Object.keys(nodeStatus);
    return mainNodes[Math.floor(Math.random() * mainNodes.length)];
}

async function parseWithTimeout(bvid, timeoutMs = 10000) {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('解析超時')); }, timeoutMs);
        try {
            const result = await parseVideoWithRetry(bvid);
            clearTimeout(timeout);
            resolve(result);
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}

async function parseWithTimeoutForNiche(bvid, timeoutMs = 10000) {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('Niche 解析超時')); }, timeoutMs);
        try {
            const result = await parseVideoWithRetryForNiche(bvid);
            clearTimeout(timeout);
            resolve(result);
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}

async function parseVideoWithRetry(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const attemptStartTime = Date.now();
            console.log(`🔄 嘗試解析 (第 ${attempt}/${maxRetries} 次): ${bvid} | 開始時間: ${new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}`);
            
            const videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.bilibili.com/'
                }
            });

            if (videoInfoResponse.data.code === 0) {
                const videoData = videoInfoResponse.data.data;
                const cid = videoData.cid;
                
                // qn=64 為 720P
                const streamResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    }
                });
                
                if (streamResponse.data.code === 0) {
                    const streamData = streamResponse.data.data;
                    
                    if (streamData.dash && streamData.dash.video) {
                        const dash720P = streamData.dash.video.find(item => item.id === 64);
                        if (dash720P) {
                            const selectedMainNode = await getBestAvailableNode(bvid);
                            let mainNodeUrl = dash720P.baseUrl;
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.cloudfront\.net/, selectedMainNode);
                            
                            const attemptEndTime = Date.now();
                            const attemptTime = attemptEndTime - attemptStartTime;
                            
                            if (nodeStatus[selectedMainNode]) {
                                nodeStatus[selectedMainNode].successCount++;
                                nodeStatus[selectedMainNode].available = true;
                            }
                            
                            console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | 格式: DASH | 品質: 720P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                            return { url: mainNodeUrl, format: 'DASH', node: selectedMainNode };
                        }
                    }
                    
                    if (streamData.durl && streamData.durl.length > 0) {
                        const selectedMainNode = await getBestAvailableNode(bvid);
                        let mainNodeUrl = streamData.durl[0].url;
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.cloudfront\.net/, selectedMainNode);
                        
                        const attemptEndTime = Date.now();
                        const attemptTime = attemptEndTime - attemptStartTime;
                        
                        if (nodeStatus[selectedMainNode]) {
                            nodeStatus[selectedMainNode].successCount++;
                            nodeStatus[selectedMainNode].available = true;
                        }
                        
                        console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | 格式: FLV | 品質: 720P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptEndTime = Date.now();
            const attemptTime = attemptEndTime - attemptStartTime;
            console.log(`❌ 第 ${attempt} 次嘗試失敗: ${error.message} | 嘗試時間: ${attemptTime}ms`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function parseVideoWithRetryForNiche(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const attemptStartTime = Date.now();
            console.log(`🔄 Niche 嘗試解析 (第 ${attempt}/${maxRetries} 次): ${bvid} | 開始時間: ${new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}`);
            
            const videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.bilibili.com/'
                }
            });

            if (videoInfoResponse.data.code === 0) {
                const videoData = videoInfoResponse.data.data;
                const cid = videoData.cid;
                
                const streamResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    }
                });
                
                if (streamResponse.data.code === 0) {
                    const streamData = streamResponse.data.data;
                    
                    if (streamData.dash && streamData.dash.video) {
                        const dash720P = streamData.dash.video.find(item => item.id === 64);
                        if (dash720P) {
                            const selectedMainNode = 'upos-sz-mirror08c.bilivideo.com'; 
                            let mainNodeUrl = dash720P.baseUrl;
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.cloudfront\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.akamaized\.net/, selectedMainNode);
                            mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.cloudfront\.net/, selectedMainNode);
                            
                            const attemptEndTime = Date.now();
                            const attemptTime = attemptEndTime - attemptStartTime;
                            
                            if (nodeStatus[selectedMainNode]) {
                                nodeStatus[selectedMainNode].successCount++;
                                nodeStatus[selectedMainNode].available = true;
                            }
                            
                            console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | 格式: DASH | 品質: 720P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                            return { url: mainNodeUrl, format: 'DASH', node: selectedMainNode };
                        }
                    }
                    
                    if (streamData.durl && streamData.durl.length > 0) {
                        const selectedMainNode = 'upos-sz-mirror08c.bilivideo.com';
                        let mainNodeUrl = streamData.durl[0].url;
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.cloudfront\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.akamaized\.net/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.cloudfront\.net/, selectedMainNode);
                        
                        const attemptEndTime = Date.now();
                        const attemptTime = attemptEndTime - attemptStartTime;
                        
                        if (nodeStatus[selectedMainNode]) {
                            nodeStatus[selectedMainNode].successCount++;
                            nodeStatus[selectedMainNode].available = true;
                        }
                        
                        console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | 格式: FLV | 品質: 720P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptEndTime = Date.now();
            const attemptTime = attemptEndTime - attemptStartTime;
            console.log(`❌ Niche 第 ${attempt} 次嘗試失敗: ${error.message} | 嘗試時間: ${attemptTime}ms`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function parseAndRedirectToNiche(req, res, bvid) {
    try {
        let clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || 'unknown';
        if (clientIP.startsWith('::ffff:')) clientIP = clientIP.substring(7);
        const location = getLocationInfo(clientIP);
        
        console.log(`🔄 Niche 重定向解析: ${bvid} | 請求者: ${clientIP}`);
        
        try {
            const result = await parseWithTimeoutForNiche(bvid, 10000);
            updateCounters();
            return res.redirect(result.url);
        } catch (error) {
            throw error;
        }
        
    } catch (error) {
        console.log(`⚠️ Niche 本地解析全數失敗。立刻無縫啟用【大陸伺服器盲跳轉】...`);
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    }
}

async function parseAndRedirectTo720P(req, res, bvid) {
    try {
        let clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || 'unknown';
        if (clientIP.startsWith('::ffff:')) clientIP = clientIP.substring(7);
        const location = getLocationInfo(clientIP);
        
        console.log(`🔄 重定向解析: ${bvid} | 請求者: ${clientIP}`);
        
        try {
            const result = await parseWithTimeout(bvid, 10000);
            updateCounters();
            return res.redirect(result.url);
        } catch (error) {
            throw error;
        }
        
    } catch (error) {
        console.log(`⚠️ 原版本地解析全數失敗。立刻無縫啟用【大陸伺服器盲跳轉】...`);
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    }
}

app.get('/niche/', async (req, res) => {
    const { url } = req.query;
    if (url) {
        let processedUrl = url;
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            if (url.startsWith('www.bilibili.com') || url.startsWith('bilibili.com')) {
                processedUrl = 'https://' + url;
            } else if (url.startsWith('BV')) {
                processedUrl = 'https://www.bilibili.com/video/' + url;
            } else {
                processedUrl = 'https://' + url;
            }
        }
        
        if (processedUrl.includes('b23.tv/')) {
            const resolvedUrl = await resolveB23ShortLink(processedUrl);
            if (resolvedUrl) processedUrl = resolvedUrl;
        }
        
        if (processedUrl.includes('bilibili.com') || processedUrl.includes('bvid=') || processedUrl.includes('BV')) {
            let bvid = null;
            if (processedUrl.includes('/video/')) {
                const match = processedUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            } else if (processedUrl.includes('bvid=')) {
                const match = processedUrl.match(/bvid=(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            } else if (processedUrl.includes('BV')) {
                const match = processedUrl.match(/(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            }

            if (bvid) {
                return parseAndRedirectToNiche(req, res, bvid);
            }
        }
        return res.send(`<h2>❌ Niche 解析失敗</h2>`);
    }
    res.send(`<h2>🎯 Niche 解析工具</h2>`);
});

app.get('/', async (req, res) => {
    const { url } = req.query;
    if (url) {
        let processedUrl = url;
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            if (url.startsWith('www.bilibili.com') || url.startsWith('bilibili.com')) {
                processedUrl = 'https://' + url;
            } else if (url.startsWith('BV')) {
                processedUrl = 'https://www.bilibili.com/video/' + url;
            } else {
                processedUrl = 'https://' + url;
            }
        }
        
        if (processedUrl.includes('b23.tv/')) {
            const resolvedUrl = await resolveB23ShortLink(processedUrl);
            if (resolvedUrl) processedUrl = resolvedUrl;
        }
        
        if (processedUrl.includes('bilibili.com') || processedUrl.includes('bvid=') || processedUrl.includes('BV')) {
            let bvid = null;
            if (processedUrl.includes('/video/')) {
                const match = processedUrl.match(/\/video\/(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            } else if (processedUrl.includes('bvid=')) {
                const match = processedUrl.match(/bvid=(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            } else if (processedUrl.includes('BV')) {
                const match = processedUrl.match(/(BV[a-zA-Z0-9]+)/);
                if (match) bvid = match[1];
            }

            if (bvid) {
                return parseAndRedirectTo720P(req, res, bvid);
            }
        }
        return res.send(`<h2>❌ 解析失敗</h2>`);
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/parse/shortlink', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ success: false, message: '請提供 URL 參數' });
    try {
        if (!url.includes('b23.tv/')) return res.json({ success: false, message: '不是有效的 b23.tv 短連結' });
        const fullUrl = await resolveB23ShortLink(url);
        if (fullUrl) return res.json({ success: true, fullUrl: fullUrl, originalUrl: url });
        return res.json({ success: false, message: '無法解析短連結' });
    } catch (error) {
        return res.json({ success: false, message: '錯誤: ' + error.message });
    }
});

app.get('/api/parse/video/:bvid', async (req, res) => {
    const { bvid } = req.params;
    const useMirror = req.query.mirror === 'true';
    
    try {
        const videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.bilibili.com/' }
        });
        
        if (videoInfoResponse.data.code === 0) {
            const videoData = videoInfoResponse.data.data;
            const cid = videoData.cid;
            const title = videoData.title;
            const qualityRequests = [{ qn: 64, name: '720P', desc: '高清' }];
            
            const streamPromises = qualityRequests.map(async (quality) => {
                try {
                    const methods = [
                        {
                            url: `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16&platform=html5`,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json, text/plain, */*',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br',
                                'Connection': 'keep-alive', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site'
                            }
                        },
                        {
                            url: `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json, text/plain, */*',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br',
                                'Connection': 'keep-alive', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site'
                            }
                        }
                    ];
                    
                    let lastError = null;
                    for (const method of methods) {
                        try {
                            const response = await axios.get(method.url, { headers: method.headers, timeout: 10000 });
                            return { quality, response };
                        } catch (error) {
                            lastError = error;
                            continue;
                        }
                    }
                    throw lastError;
                } catch (error) {
                    return { quality, response: null, error: error.response?.status };
                }
            });
            
            const streamResults = await Promise.all(streamPromises);
            const results = [{ title: '影片標題', url: `https://www.bilibili.com/video/${bvid}`, type: 'info', description: title }];
            
            for (const { quality, response, error } of streamResults) {
                if (response && response.data.code === 0) {
                    const streamData = response.data.data;
                    
                    if (streamData.durl && streamData.durl.length > 0) {
                        const selectedMainNode = useMirror ? 'upos-sz-mirror08c.bilivideo.com' : await getBestAvailableNode(bvid);
                        for (const item of streamData.durl) {
                            const originalUrl = item.url;
                            let newUrl = originalUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode).replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode).replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                            results.push({ title: `${quality.name} FLV 流地址 (主節點)`, url: newUrl, type: 'stream', description: selectedMainNode === 'upos-sz-mirror08c.bilivideo.com' ? `栖隙居所適配 - ${quality.name} ${quality.desc}` : `主CDN節點: ${selectedMainNode} - ${quality.name}` });
                            results.push({ title: `${quality.name} FLV 流地址 (原始)`, url: originalUrl, type: 'stream', description: `直接 FLV 流地址` });
                        }
                    }
                    
                    if (streamData.dash && streamData.dash.video) {
                        const selectedMainNode = useMirror ? 'upos-sz-mirror08c.bilivideo.com' : await getBestAvailableNode(bvid);
                        for (const item of streamData.dash.video) {
                            const originalUrl = item.baseUrl;
                            let newUrl = originalUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode).replace(/upos-sz-[^/]+\.akamaized\.net/, selectedMainNode).replace(/upos-bj-[^/]+\.akamaized\.net/, selectedMainNode).replace(/upos-hz-[^/]+\.akamaized\.net/, selectedMainNode);
                            results.push({ title: `${quality.name} DASH 視頻流 (主節點)`, url: newUrl, type: 'stream', description: selectedMainNode === 'upos-sz-mirror08c.bilivideo.com' ? `栖隙居所適配 - ${quality.name}` : `主CDN節點: ${selectedMainNode}` });
                            results.push({ title: `${quality.name} DASH 視頻流 (原始)`, url: originalUrl, type: 'stream', description: `直接 DASH 視頻流` });
                        }
                    }
                } else {
                    results.push({ title: `${quality.name} 流地址`, url: `https://www.bilibili.com/video/${bvid}`, type: 'info', description: `${quality.name} ${quality.desc} - 獲取失敗` });
                }
            }
            res.json({ success: true, data: results });
        } else {
            res.json({ success: false, error: '獲取影片資訊失敗' });
        }
    } catch (error) {
        res.json({ success: false, error: '解析失敗' });
    }
});

app.get('/api/counters', (req, res) => {
    try { res.json({ success: true, data: getCounters() }); } catch (error) { res.status(500).json({ success: false, error: '失敗' }); }
});

app.get('/api/nodes', (req, res) => {
    try {
        const nodes = Object.keys(nodeStatus).map(node => {
            const status = nodeStatus[node];
            const totalAttempts = status.successCount + status.failCount;
            const successRate = totalAttempts > 0 ? (status.successCount / totalAttempts * 100).toFixed(1) : 0;
            return { node, region: status.region || '未知', available: status.available, lastCheck: new Date(status.lastCheck).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'}), successCount: status.successCount, failCount: status.failCount, successRate: `${successRate}%`, totalAttempts };
        });
        res.json({ success: true, data: { nodes, totalNodes: nodes.length, availableNodes: nodes.filter(n => n.available).length } });
    } catch (error) { res.status(500).json({ success: false, error: '失敗' }); }
});

app.use(express.static('.'));

app.listen(PORT, () => {
    console.log(`🚀 VRC Bilibili 解析服務器已啟動`);
});
