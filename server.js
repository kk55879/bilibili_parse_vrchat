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

app.set('trust proxy', true);

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
        return response.request?.res?.responseUrl || response.request?.res?.response?.headers?.location || response.config?.url || url;
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
    'upos-hz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '杭州' }
};

async function getBestAvailableNode(bvid) {
    const mainNodes = Object.keys(nodeStatus);
    const sortedNodes = mainNodes.sort((a, b) => {
        const aStatus = nodeStatus[a];
        const bStatus = nodeStatus[b];
        return (bStatus.successCount / (bStatus.successCount + bStatus.failCount || 1)) - (aStatus.successCount / (aStatus.successCount + aStatus.failCount || 1));
    });
    return sortedNodes[0] || 'upos-sz-estgoss.bilivideo.com';
}

// 保險 1：本地海外線路直解 (Render 本地 IP)
async function parseVideoNative(bvid) {
    const videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com/'
        },
        timeout: 4000
    });

    if (videoInfoResponse.data.code === 0) {
        const cid = videoInfoResponse.data.data.cid;
        const streamResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            },
            timeout: 4000
        });
        
        if (streamResponse.data.code === 0) {
            const streamData = streamResponse.data.data;
            if (streamData.dash && streamData.dash.video) {
                const dash720P = streamData.dash.video.find(item => item.id === 64);
                if (dash720P) {
                    const selectedMainNode = await getBestAvailableNode(bvid);
                    let mainNodeUrl = dash720P.baseUrl.replace(/upos-[^/]+\.bilivideo\.com/, selectedMainNode);
                    return { url: mainNodeUrl, format: 'DASH' };
                }
            }
        }
    }
    throw new Error('本地海外線路遭風控封鎖');
}

// 雙線調度核心 (保險 1 ➔ 保險 2 盲跳轉)
async function handleDispatch(req, res, bvid) {
    const startTime = Date.now();
    
    // 💡 1. 第一線：本地海外直解測試 (沒鎖區的片直接秒播)
    try {
        const result = await parseVideoNative(bvid);
        updateCounters();
        console.log(`✅ 【第一線：本地海外】解析成功 | 耗時: ${Date.now() - startTime}ms`);
        return res.redirect(result.url);
    } catch (e) {
        console.log(`⚠️ 【第一線】本地海外失敗（遇到版權/風控片）。立刻無縫啟用【第二線：大陸伺服器跳轉】...`);
    }

    // 💡 2. 第二線：大陸第三方伺服器跳轉 (抹除 Referer 盲導流)
    try {
        // 先花 2 秒健康檢查
        await axios.head(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`, { timeout: 2000 });
        console.log(`✈️ 【第二線：大陸伺服器】在線檢查通過！執行隱密重新導向: ${bvid}`);
        updateCounters();
        
        // 核心安全防禦：強制切斷來源 Referer，保護域名不外洩
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    } catch (finalError) {
        console.error(`❌ 雙保險全數陣亡（對方伺服器死機）。最終回彈 B 站原網址。`);
        return res.redirect(`https://www.bilibili.com/video/${bvid}`);
    }
}

// Niche 路由
app.get('/niche/', async (req, res) => {
    let url = null;
    const urlParamIndex = req.url.indexOf('url=');
    if (urlParamIndex !== -1) {
        url = req.url.substring(urlParamIndex + 4);
        try { url = decodeURIComponent(url); } catch(e){}
    }
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
        
        // 💡 核心防禦：強制擦除參數雜質，乾淨提取 BV 號
        let bvid = null;
        const cleanUrl = processedUrl.split('?')[0];
        const match = cleanUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (match) bvid = match[1];

        if (bvid) return handleDispatch(req, res, bvid);

        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        if (userAgentHeader.includes('AVProVideo') || userAgentHeader.includes('VRChat') || acceptHeader.includes('video/') || !acceptHeader.includes('text/html')) {
            return res.redirect(processedUrl);
        }
        return res.send(`<h1>❌ Niche 解析失敗</h1>`);
    }
    res.send(`<h1>🎯 Niche 解析工具</h1>`);
});

// 主頁面路由
app.get('/', async (req, res) => {
    let url = null;
    const urlParamIndex = req.url.indexOf('url=');
    if (urlParamIndex !== -1) {
        url = req.url.substring(urlParamIndex + 4);
        try { url = decodeURIComponent(url); } catch (e) {}
    }

    if (url) {
        console.log(`🌐 收到外部解析請求: ${url}`);
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
        
        // 💡 核心防禦：強制擦除參數雜質，乾淨提取 BV 號
        let bvid = null;
        const cleanUrl = processedUrl.split('?')[0];
        const match = cleanUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (match) bvid = match[1];

        if (bvid) return handleDispatch(req, res, bvid);

        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        if (userAgentHeader.includes('AVProVideo') || userAgentHeader.includes('VRChat') || acceptHeader.includes('video/') || !acceptHeader.includes('text/html')) {
            return res.redirect(processedUrl);
        }
        return res.send(`<h2>❌ 解析失敗</h2>`);
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/parse/shortlink', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ success: false, message: '請提供 URL 參數' });
    try {
        const fullUrl = await resolveB23ShortLink(url);
        if (fullUrl) return res.json({ success: true, fullUrl: fullUrl });
        return res.json({ success: false, message: '無法解析短連結' });
    } catch (error) {
        return res.json({ success: false, message: error.message });
    }
});

app.get('/api/counters', (req, res) => { res.json({ success: true, data: getCounters() }); });

app.use(express.static(path.join(__dirname, '.')));

app.listen(PORT, () => {
    console.log(`🚀 Bilibili 解析服務器已啟動`);
});
