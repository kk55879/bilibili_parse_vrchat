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

// 計數器管理函數
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
    'upos-hz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '杭州' },
    'upos-sz-mirror08c.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: 'Mirror', isMirror: true }
};

async function getBestAvailableNode(bvid) {
    const mainNodes = Object.keys(nodeStatus).filter(node => !nodeStatus[node].isMirror);
    const sortedNodes = mainNodes.sort((a, b) => {
        const aStatus = nodeStatus[a];
        const bStatus = nodeStatus[b];
        return (bStatus.successCount / (bStatus.successCount + bStatus.failCount || 1)) - (aStatus.successCount / (aStatus.successCount + aStatus.failCount || 1));
    });
    return sortedNodes[0] || 'upos-sz-estgoss.bilivideo.com';
}

// 保險 1：本地海外線路直解
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
    throw new Error('本地海外解析不可用');
}

// 保險 2（原保險 3）：開源代理線路解析（代購網址模式）
async function parseVideoWithProxyRoute(bvid) {
    const videoInfoResponse = await axios.get(`https://bili.biliapi.hk/x/web-interface/view?bvid=${bvid}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com/'
        },
        timeout: 5000
    });

    if (videoInfoResponse.data.code === 0) {
        const cid = videoInfoResponse.data.data.cid;
        const streamResponse = await axios.get(`https://bili.biliapi.hk/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            },
            timeout: 5000
        });
        
        if (streamResponse.data.code === 0) {
            const streamData = streamResponse.data.data;
            if (streamData.dash && streamData.dash.video) {
                const dash720P = streamData.dash.video.find(item => item.id === 64);
                if (dash720P) {
                    // 💡 注意：開源代理成功時，網址一定會被替換為這個 mirror08c 節點
                    const selectedMainNode = 'upos-sz-mirror08c.bilivideo.com';
                    let mainNodeUrl = dash720P.baseUrl.replace(/upos-[^/]+\.bilivideo\.com/, selectedMainNode);
                    return { url: mainNodeUrl, format: 'DASH' };
                }
            }
        }
    }
    throw new Error('開源代理代購線路不可用');
}

// 測試用分流調度（實作：1 ➔ 3 ➔ 2 順序）
async function handleDispatch(req, res, bvid) {
    const startTime = Date.now();
    
    // 💡 1. 第一線：本地海外直解測試
    try {
        const result = await parseVideoNative(bvid);
        updateCounters();
        console.log(`✅ 【第一線：本地海外】解析成功 | 耗時: ${Date.now() - startTime}ms`);
        return res.redirect(result.url);
    } catch (e) {
        console.log(`⚠️ 【第一線】失敗。準備切換至【第二線（原第三線）：開源公共代理代購】...`);
    }

    // 💡 2. 第二線（原第三線）：呼叫開源公共代理，確認其是否能獨立工作
    try {
        const result = await parseVideoWithProxyRoute(bvid);
        updateCounters();
        console.log(`✅ 【第二線：開源代理】解析成功！網址應為 mirror08c | 耗時: ${Date.now() - startTime}ms`);
        return res.redirect(result.url);
    } catch (proxyError) {
        console.log(`🚨 【第二線：開源代理】失敗或遭封鎖！退守終極防線【第三線：大陸伺服器跳轉】...`);
    }

    // 💡 3. 第三線（原第二線）：大陸第三方伺服器盲跳轉保底
    try {
        await axios.head(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`, { timeout: 2500 });
        console.log(`✈️ 【第三線：大陸伺服器】健康檢查通過！執行盲跳轉轉定向: ${bvid}`);
        updateCounters();
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    } catch (finalError) {
        console.error(`❌ 三線保險全部宣告陣亡！回彈官方原網址。`);
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
        
        // 💡 關鍵移除：移除問號後的追蹤參數雜質，乾淨提取 BV 號
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
        
        // 💡 關鍵移除：移除問號後的追蹤參數雜質，乾淨提取 BV 號
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
