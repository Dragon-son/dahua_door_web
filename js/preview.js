
// ========== 视频预览模块 ==========
// 依赖：jsmpg.js（在 HTML 中引入）
// API: jsmpeg(wsInstance, opts) — 传入 WebSocket 实例

let _previewPlayer = null;     // jsmpeg 实例
let _previewWs = null;         // WebSocket 实例
let _previewDeviceId = null;   // 当前预览的设备ID
let _previewPingTimer = null;  // 心跳定时器
let _previewStatusTimer = null;// "连接中→直播中" 容错定时器
let _previewStatusFinal = false; // 状态是否已确认为"直播中"

/**
 * 打开预览 Modal，连接 WebSocket，启动 jsmpeg 播放
 * @param {object} device  设备对象 {id, name, ip, port, ...}
 */
function openPreview(device) {
    _previewDeviceId = device.id;

    // 清除旧画布，防止残留上一个门的画面
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 更新 Modal 标题和状态
    document.getElementById('previewModalTitle').textContent = `📹 ${device.name} 实时预览`;
    document.getElementById('previewStatus').textContent = '连接中…';
    document.getElementById('previewStatus').style.color = 'var(--text3)';
    _previewStatusFinal = false;

    openModal('previewModal');
    _startPreviewStream(device.id);
}

/**
 * 关闭预览 Modal，断开连接，销毁播放器
 */
function closePreview() {
    _stopPreviewStream();
    closeModal('previewModal');
}

/**
 * 建立 WebSocket + 初始化 jsmpeg 播放器
 */
function _startPreviewStream(deviceId) {
    _stopPreviewStream(); // 先清理旧连接

    const canvas = document.getElementById('previewCanvas');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/preview/${deviceId}`;

    // 手动创建 WebSocket，再传给 jsmpeg（jsmpg.js 需要 WebSocket 实例，不支持 URL 字符串）
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    _previewWs = ws;

    ws.onopen = () => {
        console.log('[preview] WebSocket 已连接');
    };

    ws.onclose = () => {
        console.log('[preview] WebSocket 已断开');
        _updatePreviewStatus('连接已断开', 'var(--red2)');
        _stopPing();
    };

    ws.onerror = () => {
        console.log('[preview] WebSocket 错误');
        _updatePreviewStatus('连接错误', 'var(--red2)');
    };

    // 首帧到达 → 更新状态（addEventListener 不覆盖 jsmpeg 内部的 onmessage）
    ws.addEventListener('message', function onFirstFrame() {
        ws.removeEventListener('message', onFirstFrame);
        _markPreviewLive();
    });

    // 容错：3 秒后若 onload 和首帧都没触发，强制更新为直播中
    _previewStatusTimer = setTimeout(() => {
        if (!_previewStatusFinal) _markPreviewLive();
    }, 3000);

    // 初始化 jsmpeg 播放器，传入 WebSocket 实例
    // 注意：必须 new 调用，jsmpeg 是构造函数（用 this.xxx 赋值）
    _previewPlayer = new jsmpeg(ws, {
        canvas: canvas,
        autoplay: true,
        loop: false,
        onload: () => {
            console.log('[preview] 视频流已加载 (onload)');
            _markPreviewLive();
        },
        onfinished: () => {
            console.log('[preview] 流结束');
            _updatePreviewStatus('流已结束', 'var(--yellow2)');
        },
    });
}

/**
 * 停止预览：停止播放器，关闭 WS，清理心跳
 */
function _stopPreviewStream() {
    _stopPing();
    if (_previewStatusTimer) {
        clearTimeout(_previewStatusTimer);
        _previewStatusTimer = null;
    }
    if (_previewPlayer) {
        try { _previewPlayer.stop(); } catch (e) {}
        _previewPlayer = null;
    }
    if (_previewWs) {
        try { _previewWs.close(); } catch (e) {}
        _previewWs = null;
    }
    _previewDeviceId = null;
    _previewStatusFinal = false;
    // 清除画布，防止残留画面
    const canvas = document.getElementById('previewCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

/**
 * 心跳：每 20 秒发一次 ping，防止 WS 被代理超时断开
 */
function _startPing() {
    _stopPing();
    _previewPingTimer = setInterval(() => {
        if (_previewWs && _previewWs.readyState === WebSocket.OPEN) {
            _previewWs.send('ping');
        }
    }, 20000);
}

function _stopPing() {
    if (_previewPingTimer) {
        clearInterval(_previewPingTimer);
        _previewPingTimer = null;
    }
}

/**
 * 更新预览状态文字
 */
function _updatePreviewStatus(text, color) {
    const el = document.getElementById('previewStatus');
    if (el) {
        el.textContent = text;
        el.style.color = color || 'var(--text3)';
    }
}

/**
 * 标记预览已进入直播状态（防重复触发）
 */
function _markPreviewLive() {
    if (_previewStatusFinal) return;
    _previewStatusFinal = true;
    if (_previewStatusTimer) {
        clearTimeout(_previewStatusTimer);
        _previewStatusTimer = null;
    }
    _updatePreviewStatus('直播中', 'var(--accent2)');
    _startPing();
}

/**
 * 全屏预览
 */
function togglePreviewFullscreen() {
    const canvas = document.getElementById('previewCanvas');
    if (!document.fullscreenElement) {
        canvas.requestFullscreen().catch(e => toast('error', '全屏失败: ' + e.message));
    } else {
        document.exitFullscreen();
    }
}
