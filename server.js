const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const geoip = require('geoip-lite');

const app = express();

const PORT = process.env.PORT || 3000;

// 服務計數器
let serviceCounters = {
    total: 0,           // 累計總服務次數
    today: 0,           // 今日服務次數
    thisMonth: 0,       // 本月服務次數
    lastResetDate: new Date().toDateString(), // 上次重置日期
    lastResetMonth: new Date().getMonth()     // 上次重置月份
};

// 中間件
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// 配置 Express 來獲取真實 IP 地址
app.set('trust proxy', true);

// 獲取地理位置資訊的函數
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

// 獲取計數器資訊的函數
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

// 解析 b23.tv 短連結
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

// 節節狀態管理
const nodeStatus = {
    'upos-sz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '深圳' },
    'upos-bj-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '北京' },
    'upos-hz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '杭州' },
    'upos-sz-mirror08c.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: 'Mirror', isMirror: true }
};

// 智能選擇最佳節點
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

// 帶超時的解析函數
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

// 帶超時的 Niche 解析函數
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

// 核心重試引擎 (包含保險 1 與 保險 2 代理代購切換)
async function parseVideoWithRetry(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const attemptStartTime = Date.now();
        try {
            // 💡 保險 1：常規嘗試，使用本機 Render 海外 IP 請求
            let useProxyRoute = false;
            console.log(`🔄 嘗試解析 (第 ${attempt}/${maxRetries} 次): ${bvid} | 線路: 本地海外線路`);
            
            let videoInfoResponse;
            try {
                videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 5000
                });
            } catch (e) {
                // 如果連影片資訊都拿不到，直接觸發保險 2 代理線路
                useProxyRoute = true;
            }

            // 判斷是否需要啟用 保險 2
            if (useProxyRoute || (videoInfoResponse && videoInfoResponse.data.code !== 0)) {
                console.log(`⚠️ 本地線路遭風控，自動切換至【保險 2：開源社群公共代理】代購網址...`);
                useProxyRoute = true;
                videoInfoResponse = await axios.get(`https://bili.biliapi.hk/x/web-interface/view?bvid=${bvid}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 6000
                });
            }

            if (videoInfoResponse.data.code === 0) {
                const videoData = videoInfoResponse.data.data;
                const cid = videoData.cid;
                
                // 根據一、二線決定發送 API 的目標網域
                const targetDomain = useProxyRoute ? 'bili.biliapi.hk' : 'api.bilibili.com';
                
                const streamResponse = await axios.get(`https://${targetDomain}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 6000
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
                            console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | DASH | 品質: 720P | 耗時: ${attemptTime}ms`);
                            return { url: mainNodeUrl, format: 'DASH', node: selectedMainNode };
                        }
                    }
                    
                    if (streamData.durl && streamData.durl.length > 0) {
                        const selectedMainNode = await getBestAvailableNode(bvid);
                        let mainNodeUrl = streamData.durl[0].url;
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                        
                        const attemptEndTime = Date.now();
                        const attemptTime = attemptEndTime - attemptStartTime;
                        
                        if (nodeStatus[selectedMainNode]) {
                            nodeStatus[selectedMainNode].successCount++;
                            nodeStatus[selectedMainNode].available = true;
                        }
                        console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | FLV | 品質: 720P | 耗時: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptTime = Date.now() - attemptStartTime;
            console.log(`❌ 第 ${attempt} 次嘗試失敗: ${error.message} | 嘗試時間: ${attemptTime}ms`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 重試解析函數（Niche 專用 - 整合保險 1 與 2）
async function parseVideoWithRetryForNiche(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const attemptStartTime = Date.now();
        try {
            let useProxyRoute = false;
            console.log(`🔄 Niche 嘗試解析 (第 ${attempt}/${maxRetries} 次): ${bvid} | 線路: 本地海外線路`);
            
            let videoInfoResponse;
            try {
                videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 5000
                });
            } catch (e) {
                useProxyRoute = true;
            }

            if (useProxyRoute || (videoInfoResponse && videoInfoResponse.data.code !== 0)) {
                console.log(`⚠️ Niche 本地線路遭風控，自動切換至【保險 2：開源社群公共代理】...`);
                useProxyRoute = true;
                videoInfoResponse = await axios.get(`https://bili.biliapi.hk/x/web-interface/view?bvid=${bvid}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 6000
                });
            }

            if (videoInfoResponse.data.code === 0) {
                const videoData = videoInfoResponse.data.data;
                const cid = videoData.cid;
                
                const targetDomain = useProxyRoute ? 'bili.biliapi.hk' : 'api.bilibili.com';
                
                const streamResponse = await axios.get(`https://${targetDomain}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    timeout: 6000
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
                            console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | DASH | 品質: 720P | 耗時: ${attemptTime}ms`);
                            return { url: mainNodeUrl, format: 'DASH', node: selectedMainNode };
                        }
                    }
                    
                    if (streamData.durl && streamData.durl.length > 0) {
                        const selectedMainNode = 'upos-sz-mirror08c.bilivideo.com';
                        let mainNodeUrl = streamData.durl[0].url;
                        mainNodeUrl = mainNodeUrl.replace(/upos-sz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-bj-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-hz-[^/]+\.bilivideo\.com/, selectedMainNode);
                        mainNodeUrl = mainNodeUrl.replace(/upos-[^/]+-[^/]+\.bilivideo\.com/, selectedMainNode);
                        
                        const attemptEndTime = Date.now();
                        const attemptTime = attemptEndTime - attemptStartTime;
                        
                        if (nodeStatus[selectedMainNode]) {
                            nodeStatus[selectedMainNode].successCount++;
                            nodeStatus[selectedMainNode].available = true;
                        }
                        console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | FLV | 品質: 720P | 耗時: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptTime = Date.now() - attemptStartTime;
            console.log(`❌ Niche 第 ${attempt} 次嘗試失敗: ${error.message} | 耗時: ${attemptTime}ms`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 解析並重定向到 Niche 節點
async function parseAndRedirectToNiche(req, res, bvid) {
    const startTime = Date.now();
    try {
        const result = await parseWithTimeoutForNiche(bvid, 10000);
        updateCounters();
        return res.redirect(result.url);
    } catch (error) {
        // 💡 保險 3：一、二線全部徹底失敗，抹除出處 Referer 跳轉至大陸備用線路
        console.log(`🚨 [Niche 路由] 一、二線均告失敗！啟動【保險 3：終極大陸跳轉】(隱藏 Referer 模式): ${bvid}`);
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    }
}

// 解析並重定向到主服務節點
async function parseAndRedirectToMain(req, res, bvid) {
    const startTime = Date.now();
    try {
        const result = await parseWithTimeout(bvid, 10000);
        updateCounters();
        return res.redirect(result.url);
    } catch (error) {
        // 💡 保險 3：一、二線全部徹底失敗，抹除出處 Referer 跳轉至大陸備用線路
        console.log(`🚨 [主路由] 一、二線均告失敗！啟動【保險 3：終極大陸跳轉】(隱藏 Referer 模式): ${bvid}`);
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(`http://ckapi.sevenbrothers.cn/bili/api?id=${bvid}`);
    }
}

// Niche 專用路由
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
        
        let bvid = null;
        const match = processedUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (match) bvid = match[1];

        if (bvid && (processedUrl.includes('bilibili.com') || processedUrl.includes('BV'))) {
            return parseAndRedirectToNiche(req, res, bvid);
        }

        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        const isVRChat = userAgentHeader.includes('AVProVideo') || userAgentHeader.includes('VRChat') || acceptHeader.includes('video/') || !acceptHeader.includes('text/html');

        if (isVRChat) return res.redirect(processedUrl);
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
        
        let bvid = null;
        const match = processedUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (match) bvid = match[1];

        if (bvid && (processedUrl.includes('bilibili.com') || processedUrl.includes('BV'))) {
            return parseAndRedirectToMain(req, res, bvid);
        }

        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        const isVRChat = userAgentHeader.includes('AVProVideo') || 
                         userAgentHeader.includes('VRChat') || 
                         acceptHeader.includes('video/') ||
                         !acceptHeader.includes('text/html');

        if (isVRChat) {
            console.log(`✈️ [主路由] 非 B 站連結 (遊戲播放器)，直接 302 放行: ${processedUrl}`);
            return res.redirect(processedUrl);
        }

        return res.send(`
            <!DOCTYPE html>
            <html lang="zh-TW">
            <head><meta charset="UTF-8"><title>解析失敗</title><style>body { font-family: Arial; background: #1a1a1a; color: #fff; text-align: center; padding: 50px; } .error { background: #333; padding: 20px; border-radius: 8px; border: 2px solid #ff4444; display: inline-block; }</style></head>
            <body><div class="error"><h2>❌ 解析失敗</h2><p>請提供完整的 Bilibili 影片連結</p></div></body>
            </html>
        `);
    }
    
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API 端點 - 解析 b23.tv 短連結
app.get('/api/parse/shortlink', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ success: false, message: '請提供 URL 參數' });
    try {
        if (!url.includes('b23.tv/')) return res.json({ success: false, message: '不是有效的 b23.tv 短連結' });
        const fullUrl = await resolveB23ShortLink(url);
        if (fullUrl) return res.json({ success: true, fullUrl: fullUrl, originalUrl: url });
        return res.json({ success: false, message: '無法解析短連結' });
    } catch (error) {
        return res.json({ success: false, message: error.message });
    }
});

app.get('/api/counters', (req, res) => { res.json({ success: true, data: getCounters() }); });

app.get('/api/nodes', (req, res) => {
    const nodes = Object.keys(nodeStatus).map(node => ({ node, available: nodeStatus[node].available }));
    res.json({ success: true, data: { nodes } });
});

app.use(express.static(path.join(__dirname, '.')));

app.listen(PORT, () => {
    console.log(`🚀 Bilibili 解析服務器已啟動`);
});
