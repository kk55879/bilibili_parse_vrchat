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

// 解析 b23.tv 短連結，獲取完整的 Bilibili URL
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

// 節點狀態管理 - 三個主要節點 + Mirror 節點
const nodeStatus = {
    'upos-sz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '深圳' },
    'upos-bj-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '北京' },
    'upos-hz-estgoss.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: '杭州' },
    'upos-sz-mirror08c.bilivideo.com': { available: true, lastCheck: 0, successCount: 0, failCount: 0, region: 'Mirror', isMirror: true }
};

// 檢查節點是否可用
async function checkNodeAvailability(node, bvid) {
    try {
        const testUrl = `https://${node}/upgcxcode/00/44/1234567890/${bvid}/1-112.flv?deadline=1234567890&gen=playurl&nbs=1&oi=1234567890&os=upos-sz&platform=pc&trid=1234567890&uipk=5&upsig=1234567890&uparams=,C0,E0&mid=0&orderid=0,3&agrr=0&logo=80000000`;
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

function getRandomMainNode() {
    const mainNodes = Object.keys(nodeStatus);
    return mainNodes[Math.floor(Math.random() * mainNodes.length)];
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

// 重試解析函數 (完全還原原版邏輯)
async function parseVideoWithRetry(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const attemptStartTime = Date.now(); // 只修復這裡的作用域
        try {
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
                
                // 還原原版的 qn=80
                const streamResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    }
                });
                
                if (streamResponse.data.code === 0) {
                    const streamData = streamResponse.data.data;
                    
                    if (streamData.dash && streamData.dash.video) {
                        // 還原原版的 id === 112 判斷
                        const dash1440P = streamData.dash.video.find(item => item.id === 112);
                        if (dash1440P) {
                            const selectedMainNode = await getBestAvailableNode(bvid);
                            let mainNodeUrl = dash1440P.baseUrl;
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
                            console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | 格式: DASH | 品質: 1440P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
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
                        console.log(`✅ 解析成功 (第 ${attempt} 次嘗試) | 格式: FLV | 品質: 1440P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptEndTime = Date.now();
            const attemptTime = attemptEndTime - attemptStartTime;
            console.log(`❌ 第 ${attempt} 次嘗試失敗: ${error.message} | 嘗試時間: ${attemptTime}ms`);
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 重試解析函數（Niche 專用 - 完全還原原版）
async function parseVideoWithRetryForNiche(bvid, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const attemptStartTime = Date.now();
        try {
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
                
                const streamResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=16&platform=html5`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    }
                });
                
                if (streamResponse.data.code === 0) {
                    const streamData = streamResponse.data.data;
                    
                    if (streamData.dash && streamData.dash.video) {
                        const dash1440P = streamData.dash.video.find(item => item.id === 112);
                        if (dash1440P) {
                            const selectedMainNode = 'upos-sz-mirror08c.bilivideo.com';
                            let mainNodeUrl = dash1440P.baseUrl;
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
                            console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | 格式: DASH | 品質: 1440P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
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
                        console.log(`✅ Niche 解析成功 (第 ${attempt} 次嘗試) | 格式: FLV | 品質: 1440P | 節點: ${selectedMainNode} | 嘗試時間: ${attemptTime}ms`);
                        return { url: mainNodeUrl, format: 'FLV', node: selectedMainNode };
                    }
                }
            }
            throw new Error('無法獲取流地址');
        } catch (error) {
            const attemptEndTime = Date.now();
            const attemptTime = attemptEndTime - attemptStartTime;
            console.log(`❌ Niche 第 ${attempt} 次嘗試失敗: ${error.message} | 嘗試時間: ${attemptTime}ms`);
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 解析並重定向到 Niche 節點 1440P 流地址的函數
async function parseAndRedirectToNiche(req, res, bvid) {
    try {
        let clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
        if (clientIP.startsWith('::ffff:')) { clientIP = clientIP.substring(7); }
        const userAgent = req.headers['user-agent'] || 'unknown';
        const acceptLanguage = req.headers['accept-language'] || 'unknown';
        const referer = req.headers['referer'] || 'direct';
        const timestamp = new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
        const location = getLocationInfo(clientIP);
        
        const startTime = Date.now();
        console.log(`🔄 Niche 重定向解析: ${bvid}`);
        console.log(`   請求者: ${clientIP} | 位置: ${location} | 時間: ${timestamp}`);
        
        try {
            const result = await parseWithTimeoutForNiche(bvid, 10000);
            const endTime = Date.now();
            const parseTime = endTime - startTime;
            const counters = updateCounters();
            console.log(`✅ Niche 解析成功 | 格式: ${result.format} | 節點: ${result.node} | 解析時間: ${parseTime}ms | 今日${counters.today}次`);
            return res.redirect(result.url);
        } catch (error) {
            const parseTime = Date.now() - startTime;
            console.log(`❌ Niche 解析失敗: ${bvid} - ${error.message} | 解析時間: ${parseTime}ms`);
            throw error;
        }
    } catch (error) {
        console.error(`❌ Niche 解析重定向錯誤: ${bvid} - ${error.message}`);
        return res.redirect(`https://www.bilibili.com/video/${bvid}`);
    }
}

// 解析並重定向到 1440P 流地址的函數
async function parseAndRedirectTo1440P(req, res, bvid) {
    try {
        let clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
        if (clientIP.startsWith('::ffff:')) { clientIP = clientIP.substring(7); }
        const userAgent = req.headers['user-agent'] || 'unknown';
        const acceptLanguage = req.headers['accept-language'] || 'unknown';
        const referer = req.headers['referer'] || 'direct';
        const timestamp = new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
        const location = getLocationInfo(clientIP);
        
        const startTime = Date.now();
        console.log(`🔄 重定向解析: ${bvid}`);
        console.log(`   請求者: ${clientIP} | 位置: ${location} | 時間: ${timestamp}`);
        
        try {
            const result = await parseWithTimeout(bvid, 10000);
            const endTime = Date.now();
            const parseTime = endTime - startTime;
            const counters = updateCounters();
            console.log(`✅ 解析成功 | 格式: ${result.format} | 節點: ${result.node} | 解析時間: ${parseTime}ms | 今日${counters.today}次`);
            return res.redirect(result.url);
        } catch (error) {
            const parseTime = Date.now() - startTime;
            console.log(`❌ 解析失敗: ${bvid} - ${error.message} | 解析時間: ${parseTime}ms`);
            throw error;
        }
    } catch (error) {
        console.error(`❌ 解析重定向錯誤: ${bvid} - ${error.message}`);
        return res.redirect(`https://www.bilibili.com/video/${bvid}`);
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
        let clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
        if (clientIP.startsWith('::ffff:')) { clientIP = clientIP.substring(7); }
        const timestamp = new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
        console.log(`🎯 Niche 解析請求: ${url} (強制使用 upos-sz-mirror08c)`);

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

        // 新增防禦分流
        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        const isVRChat = userAgentHeader.includes('AVProVideo') || userAgentHeader.includes('VRChat') || acceptHeader.includes('video/') || !acceptHeader.includes('text/html');

        if (isVRChat) return res.redirect(processedUrl);
        return res.send(`<h1>❌ Niche 解析失敗</h1>`);
    }
    
    res.send(`<h1>🎯 Niche 解析工具</h1>`);
});

// 主頁面路由 - 處理 URL 參數重定向
app.get('/', async (req, res) => {
    let url = null;
    const urlParamIndex = req.url.indexOf('url=');
    if (urlParamIndex !== -1) {
        url = req.url.substring(urlParamIndex + 4);
        try { url = decodeURIComponent(url); } catch (e) {}
    }

    if (url) {
        let clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
        if (clientIP.startsWith('::ffff:')) { clientIP = clientIP.substring(7); }
        const timestamp = new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
        
        console.log(`🌐 解析請求: ${url}`);

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
                return parseAndRedirectTo1440P(req, res, bvid);
            }
        }

        // 新增防禦分流
        const userAgentHeader = req.headers['user-agent'] || '';
        const acceptHeader = req.headers['accept'] || '';
        const isVRChat = userAgentHeader.includes('AVProVideo') || userAgentHeader.includes('VRChat') || acceptHeader.includes('video/') || !acceptHeader.includes('text/html');

        if (isVRChat) {
            console.log(`✈️ [主路由] 非 B 站連結，直接放行重定向: ${processedUrl}`);
            return res.redirect(processedUrl);
        }

        return res.send(`
            <!DOCTYPE html>
            <html lang="zh-TW">
            <head><meta charset="UTF-8"><title>解析失敗</title><style>body { font-family: Arial; background: #1a1a1a; color: #fff; text-align: center; padding: 50px; } .error { background: #333; padding: 20px; border-radius: 8px; border: 2px solid #ff4444; }</style></head>
            <body><div class="error"><h2>❌ 解析失敗</h2><p>請提供完整的 Bilibili 影片連結</p><p><a href="/" style="color: #4CAF50;">返回首頁</a></p></div></body>
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

// API 端點 - 影片解析
app.get('/api/parse/video/:bvid', async (req, res) => {
    const { bvid } = req.params;
    const useMirror = req.query.mirror === 'true';
    try {
        const videoInfoResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (videoInfoResponse.data.code === 0) {
            const cid = videoInfoResponse.data.data.cid;
            const qualityRequests = [{ qn: 112, name: '1440P', desc: '2K超高清' }];
            const streamPromises = qualityRequests.map(async (quality) => {
                try {
                    const methods = [
                        { url: `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16&platform=html5`, headers: { 'User-Agent': 'Mozilla/5.0' } },
                        { url: `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${quality.qn}&fnval=16`, headers: { 'User-Agent': 'Mozilla/5.0' } }
                    ];
                    let lastError = null;
                    for (const method of methods) {
                        try {
                            const response = await axios.get(method.url, { headers: method.headers, timeout: 10000 });
                            return { quality, response };
                        } catch (error) { lastError = error; continue; }
                    }
                    throw lastError;
                } catch (error) { return { quality, response: null, error: error.response?.status }; }
            });
            const streamResults = await Promise.all(streamPromises);
            res.json({ success: true, data: [] });
        } else {
            res.json({ success: false, error: '獲取影片資訊失敗' });
        }
    } catch (error) {
        res.json({ success: false, error: '解析失敗' });
    }
});

app.get('/api/counters', (req, res) => { res.json({ success: true, data: getCounters() }); });

app.get('/api/nodes', (req, res) => {
    const nodes = Object.keys(nodeStatus).map(node => {
        const status = nodeStatus[node];
        return { node, available: status.available };
    });
    res.json({ success: true, data: { nodes } });
});

app.use(express.static('.'));

app.listen(PORT, () => {
    console.log(`🚀 VRC Bilibili 解析服務器已啟動`);
});
