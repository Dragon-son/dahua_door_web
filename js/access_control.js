const API = window.location.origin;

// 校验日期字符串是否合法（处理 SDK 返回的 "0-00-00" 等无效值）
function safeDate(str, fallback) {
    if (!str || typeof str !== 'string') return fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return fallback;
    const d = new Date(str);
    if (isNaN(d.getTime())) return fallback;
    return str;
}
let devices = [];
let areas = [];
let currentDev = null;
let currentDoor = 0;
let currentPDevObj = null;
let editDevId = null;
let editPersonId = null;
let faceUid = null;
let facePendingDevices = null;  // savePerson 上下文中待下发设备列表
let _pendingPersonSave = null;   // 编辑延迟保存上下文
let logData = [];
let logFilter = '';
let logRefreshTimer = null;
let doorStatusTimer = null;
let devicePageMode = false;
let currentDevicePageData = [];
let currentRole = 'user';   // 'admin' | 'user'
let adminEditUsername = null; // 当前编辑的用户名（null=新建）
let assignTargetUsername = null;
let _devicesLoaded = false;  // 设备列表是否已加载完毕（区分"加载中"和"真没有"）

// 登录相关
async function checkLogin() {
    const auth = getCookie("auth");
    if (auth) { 
        try {
            const resp = await fetch('/api/user', { credentials: 'include' });
            const data = await resp.json();
            if (data.code === 0 && data.data && data.data.username) {
                showMainApp(data.data.role || 'user');
                return;
            }
        } catch(e) {}
        showMainApp('user');
        return;
    }
    try {
        const resp = await fetch('/api/user', { credentials: 'include' });
        const data = await resp.json();
        if (data.code === 0 && data.data && data.data.username) showMainApp(data.data.role || 'user');
        else showLoginPage();
    } catch (e) { showLoginPage(); }
}
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}
function showLoginPage() {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
    document.getElementById('login-username').focus();
}
function showMainApp(role) {
    currentRole = role || 'user';
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('main-app').style.display = 'flex';
    applyRoleUI();
    initMain();
}

function applyRoleUI() {
    const isAdmin = currentRole === 'admin';
    document.getElementById('nav-admin').style.display = isAdmin ? '' : 'none';
    // 管理员专属按钮（设备管理页）
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });
}
async function doLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const msgEl = document.getElementById('login-msg');
    if (!username || !password) { msgEl.textContent = '请输入用户名和密码'; return; }
    try {
        const resp = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const data = await resp.json();
        if (data.code === 0) showMainApp(data.data && data.data.role ? data.data.role : 'user');
        else msgEl.textContent = data.msg || '登录失败';
    } catch (e) { msgEl.textContent = '网络错误，登录失败'; }
}
async function doLogout() {
    await fetch(`${API}/api/logout`, { method: 'POST' });
    document.cookie = "auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    showLoginPage();
}
function showRegisterForm() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    document.getElementById('login-msg').textContent = '';
}
function showLoginForm() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('login-msg').textContent = '';
}
async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value.trim();
    const password2 = document.getElementById('reg-password2').value.trim();
    const msgEl = document.getElementById('login-msg');
    if (!username || !password) { msgEl.textContent = '用户名和密码不能为空'; return; }
    if (password !== password2) { msgEl.textContent = '两次密码输入不一致'; return; }
    try {
        const resp = await fetch(`${API}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const data = await resp.json();
        if (data.code === 0) { alert('注册成功，请登录'); showLoginForm(); }
        else msgEl.textContent = data.msg || '注册失败';
    } catch (e) { msgEl.textContent = '网络错误，注册失败'; }
}

// ========== 区域 API ==========
async function loadAreas() {
    try {
        const resp = await fetch(`${API}/api/areas`);
        const data = await resp.json();
        if (data.code === 0) {
            areas = data.data;
            renderAreaSelect();
            renderAreaList();
        } else {
            toast('error', '加载区域列表失败: ' + data.msg);
        }
    } catch (e) {
        console.error('loadAreas error:', e);
        toast('error', '无法连接服务器，请检查后端');
    }
}

async function addArea() {
    const name = document.getElementById('newAreaName').value.trim();
    if (!name) { toast('error', '请输入区域名称'); return; }
    try {
        const resp = await fetch(`${API}/api/areas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const data = await resp.json();
        if (data.code === 0) {
            toast('success', `区域「${name}」已添加`);
            document.getElementById('newAreaName').value = '';
            await loadAreas();
            await loadDevicesFromServer();
        } else { toast('error', data.msg); }
    } catch (e) { toast('error', '添加失败'); }
}

async function deleteArea(areaName) {
    if (!confirm(`确定删除区域「${areaName}」吗？`)) return;
    try {
        const resp = await fetch(`${API}/api/areas/${encodeURIComponent(areaName)}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.code === 0) {
            toast('success', `区域「${areaName}」已删除`);
            await loadAreas();
            await loadDevicesFromServer();
        } else { toast('error', data.msg); }
    } catch (e) { toast('error', '删除失败'); }
}

function renderAreaSelect() {
    const select = document.getElementById('d-area');
    if (!select) return;
    select.innerHTML = '';
    areas.forEach(area => { const o = document.createElement('option'); o.value = area; o.textContent = area; select.appendChild(o); });
    if (areas.length) select.value = areas[0];
}

function renderAreaList() {
    const tbody = document.getElementById('areaListBody');
    if (!tbody) return;
    if (!areas.length) { tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:20px">暂无区域</td></tr>'; return; }
    tbody.innerHTML = areas.map(area => `<tr><td>${escapeHtml(area)}</td><td><button class="btn btn-danger btn-sm" onclick="deleteArea('${escapeHtml(area)}')">删除</button></td></tr>`).join('');
}

function openAreaModal() { renderAreaList(); openModal('areaModal'); }

// ========== 设备 API ==========
async function loadDevicesFromServer() {
    try {
        const resp = await fetch(`${API}/api/devices`);
        const data = await resp.json();
        if (data.code === 0) { devices = data.data; _devicesLoaded = true; renderAccessGrid(); renderDevTable(); fillPersonDevSel(); }
        else toast('error', data.msg);
    } catch (e) { _devicesLoaded = true; toast('error', '无法连接服务器'); }
}

async function refreshDevices() { await loadDevicesFromServer(); }

function compareIP(ipA, ipB) { const pA=ipA.split('.').map(Number), pB=ipB.split('.').map(Number); for(let i=0;i<4;i++) if(pA[i]!==pB[i]) return pA[i]-pB[i]; return 0; }
function sortDevices(devArray) { const order = {}; areas.forEach((a,i)=>order[a]=i); return [...devArray].sort((a,b)=>(order[a.area]??9999)-(order[b.area]??9999)||compareIP(a.ip,b.ip)); }

function renderDevTable(filter='') {
    const tbody = document.getElementById('devBody');
    let data = filter ? devices.filter(d=>d.name.includes(filter)||d.ip.includes(filter)) : devices;
    data = sortDevices(data);
    const online = devices.filter(d=>d.online).length;
    document.getElementById('stat-total').textContent = devices.length;
    document.getElementById('stat-online').textContent = online;
    document.getElementById('stat-offline').textContent = devices.length - online;
    if (!data.length) {
        tbody.innerHTML = _devicesLoaded
            ? `<tr><td colspan="7"><div class="empty-state"><p>暂无设备</p></div></td></tr>`
            : `<tr><td colspan="7"><div class="empty-state"><span class="spinner"></span><p>正在加载设备…</p></div></td></tr>`;
        return;
    }
    tbody.innerHTML = data.map(d => `<tr>
        <td><strong>${escapeHtml(d.name)}</strong>${d.note?`<br><span style="font-size:11.5px;color:var(--text3)">${escapeHtml(d.note)}</span>`:''}</td>
        <td><span class="mono">${d.ip}</span></td><td><span class="mono">${d.port}</span></td><td><span class="mono">${escapeHtml(d.username)}</span></td>
        <td><span class="badge bgr">${escapeHtml(d.area)}</span></td>
        <td><span class="badge ${d.online?'bg':'br'}">${d.online?'在线':'离线'}</span></td>
        <td><div class="dev-actions"><button class="btn btn-ghost btn-sm" onclick="openDeviceModal(${d.id})">⚙ 设置</button><button class="btn btn-danger btn-sm" onclick="confirmDelDev(${d.id})">删除</button></div></td>
    </tr>`).join('');
}

function filterDevices(v) { renderDevTable(v); }

function openDeviceModal(id=null) {
    editDevId = id;
    document.getElementById('devModalTitle').textContent = id ? '编辑设备' : '添加设备';
    renderAreaSelect();
    if (id) {
        const d = devices.find(x=>x.id===id);
        if (d) {
            document.getElementById('d-name').value = d.name;
            document.getElementById('d-ip').value = d.ip;
            document.getElementById('d-port').value = d.port;
            document.getElementById('d-area').value = d.area;
            document.getElementById('d-user').value = d.username;
            document.getElementById('d-pass').value = d.password;
            document.getElementById('d-note').value = d.note||'';
        }
    } else {
        ['d-name','d-ip','d-port','d-user','d-pass','d-note'].forEach(f=>document.getElementById(f).value='');
        if (areas.length) document.getElementById('d-area').value = areas[0];
    }
    openModal('devModal');
}

async function saveDevice() {
    const name = document.getElementById('d-name').value.trim();
    const ip = document.getElementById('d-ip').value.trim();
    if (!name||!ip) { toast('error','请填写设备名称和 IP 地址'); return; }
    const area = document.getElementById('d-area').value;
    if (!area) { toast('error','请选择区域'); return; }
    const obj = { name, ip, port: parseInt(document.getElementById('d-port').value) || 37777, area, username: document.getElementById('d-user').value || 'admin', password: document.getElementById('d-pass').value || '', note: document.getElementById('d-note').value || '' };
    let res;
    if (editDevId) {
        res = await updateDeviceToServer(editDevId, obj);
        if (res.code===0) toast('success', `设备「${name}」已更新`);
        else toast('error', `更新失败：${res.msg}`);
    } else {
        res = await addDeviceToServer(obj);
        if (res.code===0) toast('success', `设备「${name}」已添加`);
        else toast('error', `添加失败：${res.msg}`);
    }
    if (res.code===0) { closeModal('devModal'); await loadDevicesFromServer(); }
}

async function addDeviceToServer(device) {
    const resp = await fetch(`${API}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) });
    return resp.json();
}

async function updateDeviceToServer(id, device) {
    const resp = await fetch(`${API}/api/devices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) });
    return resp.json();
}

async function deleteDeviceFromServer(id) {
    const resp = await fetch(`${API}/api/devices/${id}`, { method: 'DELETE' });
    return resp.json();
}

async function confirmDelDev(id) {
    const d = devices.find(x=>x.id===id);
    if (!d) return;
    setConfirm('删除设备', `确定删除设备 <span class="confirm-hi">「${escapeHtml(d.name)}」</span>（${escapeHtml(d.ip)}）？相关人员数据将一并清除。`, async () => {
        const res = await deleteDeviceFromServer(id);
        if (res.code===0) {
            toast('success', `已删除设备「${d.name}」`);
            await loadDevicesFromServer();
        } else { toast('error', `删除失败：${res.msg}`); }
    });
}

// ========== 通用 API 请求（携带设备凭证）==========
async function apiRequest(method, path, device, bodyData = null, isFormData = false) {
    let url = API + path;
    let options = { method, headers: {} };
    if (method === 'GET' && device) {
        const params = new URLSearchParams({ device_ip: device.ip, device_port: device.port, username: device.username, password: device.password });
        url += (url.includes('?') ? '&' : '?') + params.toString();
    }
    if (bodyData) {
        if (isFormData) {
            bodyData.append('device_ip', device.ip);
            bodyData.append('device_port', device.port);
            bodyData.append('username', device.username);
            bodyData.append('password', device.password);
            options.body = bodyData;
        } else {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify({ ...bodyData, device_ip: device.ip, device_port: device.port, username: device.username, password: device.password });
        }
    } else if (method !== 'GET' && device) {
        const params = new URLSearchParams({ device_ip: device.ip, device_port: device.port, username: device.username, password: device.password });
        url += (url.includes('?') ? '&' : '?') + params.toString();
    }
    const resp = await fetch(url, options);
    return resp.json();
}

// ========== 健康检查 ==========
async function checkHealth() {
    let ok = false;
    try { const r = await fetch(API + '/api/health'); const data = await r.json(); ok = data.code === 0; } catch(e) { console.warn('Health check failed', e); }
    document.getElementById('srvDot').className = ok ? 'status-dot' : 'status-dot offline';
    document.getElementById('srvLabel').textContent = ok ? '服务已连接' : '服务未连接';
    ['access','devices','persons'].forEach(p => document.getElementById('banner-'+p).classList.toggle('show', !ok));
}

// ========== 页面导航 ==========
function showPage(name) {
    stopAutoRefresh();
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-'+name).classList.add('active');
    const pages = ['access','devices','persons','admin'];
    document.querySelectorAll('.nav-item').forEach((n,i) => n.classList.toggle('active', pages[i] === name));
    document.getElementById('breadcrumb').innerHTML = `<span>${{access:'门禁控制',devices:'设备管理',persons:'人员管理',admin:'用户管理'}[name]}</span>`;
    document.getElementById('topbarActions').innerHTML = '';
    if (name === 'devices') { if (areas.length === 0) { loadAreas().then(() => renderDevTable()); } else { renderDevTable(); } }
    if (name==='persons') {
        fillPersonDevSel();
        document.getElementById('personContent').style.display = 'block';
        document.getElementById('personPH').style.display = 'none';
        currentPDevObj = null;
        currentViewMode = 'local';
        document.getElementById('searchUserId').value = '';
        document.getElementById('searchUserName').value = '';
        loadAllPersons();
    }
    if (name==='access') { showAccessList(); renderAccessGrid(); }
    if (name==='admin') { loadAdminUsers(); }
    checkHealth();
}

// ========== 门禁控制模块 ==========
function getAreaIcon(areaName) { const map = {'传动轴':'⚙️','部件':'🏗️','底零':'📦','精铸':'🏭','车轮':'🚗','其他':'📍'}; return map[areaName] || '📍'; }
function createDeviceCard(device) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.onclick = () => openDetail(device);
    card.innerHTML = `<div class="dc-status"><span class="badge bgr" style="font-size:10.5px">● 本地</span></div><div class="dc-icon">🚪</div><div class="dc-name">${escapeHtml(device.name)}</div><div class="dc-ip">${device.ip}:${device.port}</div>${device.note ? `<div style="font-size:11.5px;color:var(--text3);margin-top:4px">${escapeHtml(device.note)}</div>` : ''}`;
    return card;
}
function toggleArea(gridId, iconId) { const grid = document.getElementById(gridId); const icon = document.getElementById(iconId); if (!grid || !icon) return; if (grid.style.display === 'none' || grid.style.display === '') { grid.style.display = 'grid'; icon.textContent = '▼'; } else { grid.style.display = 'none'; icon.textContent = '▶'; } }
function renderAccessGrid() {
    const container = document.getElementById('access-areas-container');
    if (!container) return;
    if (devices.length === 0) {
        if (!_devicesLoaded) {
            // 设备还在后台加载中，显示骨架占位
            container.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>正在加载设备…</p></div>`;
        } else {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><p>暂无设备，请前往"设备管理"添加</p></div>`;
        }
        return;
    }

    // 记住当前展开的折叠区域
    const expandedAreas = new Set();
    if (container.children.length > 0) {
        container.querySelectorAll('.device-grid').forEach(grid => {
            if (grid.style.display !== 'none' && grid.style.display !== '') {
                expandedAreas.add(grid.id);
            }
        });
    }

    const devicesByArea = {};
    devices.forEach(d => { const area = d.area || '未分组'; if (!devicesByArea[area]) devicesByArea[area] = []; devicesByArea[area].push(d); });
    let html = '';
    areas.forEach(areaName => {
        const areaDevices = devicesByArea[areaName] || [];
        if (areaDevices.length === 0) return;
        const gridId = `grid-${areaName.replace(/\s+/g, '_')}`;
        const iconId = `icon-${gridId}`;
        html += `<div class="area-section"><div class="area-title" onclick="toggleArea('${gridId}','${iconId}')"><span id="${iconId}" style="font-size:14px;margin-right:6px;">▶</span><span>${getAreaIcon(areaName)}</span> ${escapeHtml(areaName)}<span style="margin-left:8px;font-size:11px;color:var(--text3);">(${areaDevices.length}个设备)</span></div><div class="device-grid" id="${gridId}" style="display:none;"></div></div>`;
    });
    const extraAreas = Object.keys(devicesByArea).filter(area => !areas.includes(area));
    extraAreas.forEach(areaName => {
        const areaDevices = devicesByArea[areaName];
        if (areaDevices.length === 0) return;
        const gridId = `grid-${areaName.replace(/\s+/g, '_')}`;
        const iconId = `icon-${gridId}`;
        html += `<div class="area-section"><div class="area-title" onclick="toggleArea('${gridId}','${iconId}')"><span id="${iconId}" style="font-size:14px;margin-right:6px;">▶</span><span>📁</span> ${escapeHtml(areaName)}<span style="margin-left:8px;font-size:11px;color:var(--text3);">(${areaDevices.length}个设备)</span></div><div class="device-grid" id="${gridId}" style="display:none;"></div></div>`;
    });
    container.innerHTML = html;
    devices.forEach(d => { const area = d.area || '未分组'; const gridId = `grid-${area.replace(/\s+/g, '_')}`; const grid = document.getElementById(gridId); if (grid) grid.appendChild(createDeviceCard(d)); });

    // 恢复之前展开的区域
    expandedAreas.forEach(gridId => {
        const grid = document.getElementById(gridId);
        const icon = document.getElementById(`icon-${gridId}`);
        if (grid) grid.style.display = 'grid';
        if (icon) icon.textContent = '▼';
    });
}
function showAccessList() { stopAutoRefresh(); document.getElementById('access-list').style.display = 'block'; document.getElementById('access-detail').classList.remove('active'); document.getElementById('breadcrumb').innerHTML = '<span>门禁控制</span>'; renderAccessGrid(); }

// ========== 日志 ==========
function getLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function fetchLogData() {
    if (!currentDev) throw new Error('未选择设备');
    let start = document.getElementById('logEnd').value;
    let end = document.getElementById('logEnd').value;
    if (!start) {
        start = getLocalDateString();
        document.getElementById('logEnd').value = start;
    }
    if (!end) {
        end = start;
        document.getElementById('logEnd').value = end;
    }
    const url = `/api/log?start=${start}&end=${end}&device_ip=${encodeURIComponent(currentDev.ip)}&device_port=${currentDev.port}&username=${encodeURIComponent(currentDev.username)}&password=${encodeURIComponent(currentDev.password)}`;
    const r = await fetch(API + url);
    const data = await r.json();
    return data;
}

async function fetchLog() {
    if (!currentDev) return;
    const btn = document.querySelector('.btn-ghost[onclick="fetchLog()"]');
    if (btn) {
        const orig = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> 查询'; btn.disabled = true;
        try { await fetchLogDataAndProcess(false); } finally { btn.innerHTML = orig; btn.disabled = false; }
    } else { await fetchLogDataAndProcess(false); }
}

async function fetchLogDataAndProcess(silent = false) {
    try {
        const data = await fetchLogData();
        if (data.code === 0) {
            const newRecords = data.data.records || [];
            const existingKeys = new Set(logData.map(r => `${r.time}|${r.door}|${r.user_id}|${r.method}|${r.status}`));
            const uniqueNew = newRecords.filter(r => !existingKeys.has(`${r.time}|${r.door}|${r.user_id}|${r.method}|${r.status}`));
            if (uniqueNew.length > 0) {
                logData = [...uniqueNew, ...logData];
                logData.sort((a, b) => new Date(b.time) - new Date(a.time));
            }
            renderLog();
            if (!silent) {
                toast('info', uniqueNew.length ? `新增 ${uniqueNew.length} 条开门记录` : '没有新的开门记录');
            }
        } else {
            throw new Error(data.msg || '请求失败');
        }
    } catch (e) {
        console.warn('获取日志失败:', e);
        const tbody = document.getElementById('logBody');
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-icon">⚠️</div><p>加载失败</p></div></td></tr>`;
        if (!silent) toast('error', '获取开门记录失败');
        throw e;
    }
}

function filterLog() { logFilter = document.getElementById('logSearch').value.toLowerCase(); renderLog(); }

async function doFetchLog(silent = false) {
    if (!currentDev) return;
    const refreshBtn = document.querySelector('#page-access .btn-ghost[onclick="fetchLog()"]');
    if (!silent && refreshBtn) {
        const originalHtml = refreshBtn.innerHTML;
        refreshBtn.innerHTML = '<span class="spinner"></span> 查询';
        refreshBtn.disabled = true;
        try {
            await fetchLogDataAndProcess(silent);
        } finally {
            refreshBtn.innerHTML = originalHtml;
            refreshBtn.disabled = false;
        }
    } else {
        await fetchLogDataAndProcess(silent);
    }
}

function filterLog() { 
    logFilter = document.getElementById('logSearch').value.toLowerCase(); 
    renderLog(); 
}

function renderLog() {
    const tbody = document.getElementById('logBody');
    let data = logFilter ? logData.filter(r => (r.name + r.user_id).toLowerCase().includes(logFilter)) : [...logData];
    data = data.filter(r => r.door === 0);
    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-icon">📋</div><p>暂无开门记录</p></div></td></tr>`;
        return;
    }
    const mBadge = m => { const c={'人脸识别':'bb','刷卡':'by','远程开门':'bg','密码':'bgr'}; return `<span class="badge ${c[m]||'bgr'}">${escapeHtml(m)}</span>`; };
    tbody.innerHTML = data.map(r => `
        <tr>
            <td><span class="mono">${escapeHtml(r.time)}</span></td>
            <td><span class="mono">${escapeHtml(r.user_id||'—')}</span></td>
            <td>${escapeHtml(r.name||'<span style="color:var(--text3)">—</span>')}</td>
            <td>${mBadge(r.method)}</span></td>
            <td><span class="badge ${r.status==='成功'?'bg':'br'}">${escapeHtml(r.status)}</span></td>
        </tr>
    `).join('');
}

async function silentRefreshLog() {
    if (!currentDev) return;
    // 确定开始时间：列表中最新的记录时间，若无则当日 00:00:00
    let startTime;
    if (logData.length > 0) {
        startTime = logData[0].time; // 最新记录
    } else {
        startTime = getLocalDateString() + ' 00:00:00';
    }
    const endTime = getLocalDateString() + ' 23:59:59';
    
    const url = `/api/log?start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}&device_ip=${encodeURIComponent(currentDev.ip)}&device_port=${currentDev.port}&username=${encodeURIComponent(currentDev.username)}&password=${encodeURIComponent(currentDev.password)}`;
    try {
        const r = await fetch(API + url);
        const data = await r.json();
        if (data.code === 0) {
            const newRecords = data.data.records || [];
            const existingKeys = new Set(logData.map(r => `${r.time}|${r.door}|${r.user_id}|${r.method}|${r.status}`));
            const uniqueNew = newRecords.filter(r => !existingKeys.has(`${r.time}|${r.door}|${r.user_id}|${r.method}|${r.status}`));
            if (uniqueNew.length > 0) {
                logData = [...uniqueNew, ...logData];
                logData.sort((a, b) => new Date(b.time) - new Date(a.time));
                renderLog();
            }
        }
    } catch (e) {
        console.warn('自动刷新日志失败:', e);
    }
}

// ---------- 门状态轮询 ----------
async function fetchDoorStatus() {
    if (!currentDev) return;
    try {
        const url = `/api/door/status?channel=1&device_ip=${encodeURIComponent(currentDev.ip)}&device_port=${currentDev.port}&username=${encodeURIComponent(currentDev.username)}&password=${encodeURIComponent(currentDev.password)}`;
        const r = await fetch(API + url);
        const data = await r.json();
        if (data.code === 0) {
            updateDoorStatusUI(data.data.is_open);
        }
    } catch (e) {
        console.warn('查询门状态失败:', e);
    }
}

function updateDoorStatusUI(isOpen) {
    const icon = document.getElementById('doorStatusIcon');
    const text = document.getElementById('doorStatusText');
    if (!icon || !text) return;
    if (isOpen) {
        icon.textContent = '🔓';
        text.textContent = '门已开';
        text.style.color = 'var(--red2)';
    } else {
        icon.textContent = '🔒';
        text.textContent = '门已关';
        text.style.color = 'var(--accent)';
    }
}

function startAutoRefresh() {
    stopAutoRefresh();
    logRefreshTimer = setInterval(silentRefreshLog, 3000);
    doorStatusTimer = setInterval(fetchDoorStatus, 3000);
}

function stopAutoRefresh() {
    if (logRefreshTimer) {
        clearInterval(logRefreshTimer);
        logRefreshTimer = null;
    }
    if (doorStatusTimer) {
        clearInterval(doorStatusTimer);
        doorStatusTimer = null;
    }
}

function openDetail(dev) {
    stopAutoRefresh();
    currentDev = dev;
    currentDoor = 0;
    logFilter = '';
    document.getElementById('logSearch').value = '';
    document.getElementById('access-list').style.display = 'none';
    document.getElementById('access-detail').classList.add('active');
    document.getElementById('detail-name').textContent = dev.name;
    document.getElementById('detail-ip').textContent = `${dev.ip}:${dev.port}`;
    document.getElementById('breadcrumb').innerHTML = `<span style="cursor:pointer;color:var(--text3)" onclick="showAccessList()">门禁控制</span><span style="margin:0 4px">›</span><span style="color:var(--text2)">${escapeHtml(dev.name)}</span>`;
    // 重置门状态为默认
    updateDoorStatusUI(false);
    logData = [];
    const today = getLocalDateString();
    document.getElementById('logEnd').value = today;
    const tbody = document.getElementById('logBody');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px"><span class="spinner"></span> 加载中...</td></tr>`;
    // 首次加载：同时获取日志和门状态
    Promise.all([
        fetchLogDataAndProcess(true),
        fetchDoorStatus()
    ]).then(() => {
        startAutoRefresh();
    }).catch(() => {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-icon">⚠️</div><p>加载失败</p></div></td></tr>`;
    });
}

async function doOpenDoor() {
    if (!currentDev) return;
    const btn = document.getElementById('openDoorBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> &nbsp; 开门中…';
    try {
        const r = await apiRequest('POST', '/api/open', currentDev, { channel: currentDoor });
        if (r.code === 0) {
            toast('success', `✅ 远程开门成功（${currentDev.name}）`);
            await fetchLogDataAndProcess(true);
        } else {
            toast('error', `开门失败：${r.msg}`);
        }
    } catch(e) {
        toast('error', '无法连接服务，请检查 server.py 是否运行');
    }
    btn.disabled = false;
    btn.innerHTML = '🔓 &nbsp; 远程开门';
}

// ========== 设备管理模块 ==========
function compareIP(ipA, ipB) {
    const partsA = ipA.split('.').map(Number);
    const partsB = ipB.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
        if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
    }
    return 0;
}

function sortDevices(devArray) {
    const areaOrder = {};
    areas.forEach((area, index) => { areaOrder[area] = index; });
    return [...devArray].sort((a, b) => {
        const orderA = areaOrder[a.area] ?? 9999;
        const orderB = areaOrder[b.area] ?? 9999;
        if (orderA !== orderB) return orderA - orderB;
        return compareIP(a.ip, b.ip);
    });
}

function renderDevTable(filter='') {
    const tbody = document.getElementById('devBody');
    let data = filter ? devices.filter(d => d.name.includes(filter) || d.ip.includes(filter)) : devices;
    data = sortDevices(data);
    const onlineCount = devices.filter(d => d.online).length;
    document.getElementById('stat-total').textContent = devices.length;
    document.getElementById('stat-online').textContent = onlineCount;
    document.getElementById('stat-offline').textContent = devices.length - onlineCount;
    if (!data.length) {
        tbody.innerHTML = _devicesLoaded
            ? `<tr><td colspan="7"><div class="empty-state" style="padding:24px"><div class="empty-icon">📡</div><p>暂无设备</p></div></td></tr>`
            : `<tr><td colspan="7"><div class="empty-state" style="padding:24px"><span class="spinner"></span><p>正在加载设备…</p></div></td></tr>`;
        return;
    }
    tbody.innerHTML = data.map(d => `
        <tr>
            <td><strong style="color:var(--text)">${escapeHtml(d.name)}</strong>${d.note?`<br><span style="font-size:11.5px;color:var(--text3)">${escapeHtml(d.note)}</span>`:''}</td>
            <td><span class="mono">${escapeHtml(d.ip)}</span></td>
            <td><span class="mono">${d.port}</span></td>
            <td><span class="mono">${escapeHtml(d.username)}</span></td>
            <td><span class="badge bgr">${escapeHtml(d.area)}</span></td>
            <td><span class="badge ${d.online ? 'bg' : 'br'}">${d.online ? '在线' : '离线'}</span></td>
            <td><div class="dev-actions">${currentRole === 'admin' ? `<button class="btn btn-ghost btn-sm" onclick="openDeviceModal(${d.id})">⚙ 设置</button><button class="btn btn-danger btn-sm" onclick="confirmDelDev(${d.id})">删除</button>` : '<span style="color:var(--text3);font-size:12px">—</span>'}</div></td>
        </tr>
    `).join('');
}

function filterDevices(v) { renderDevTable(v); }

function openDeviceModal(id=null) {
    editDevId = id;
    document.getElementById('devModalTitle').textContent = id ? '编辑设备' : '添加设备';
    renderAreaSelect();
    if (id) {
        const d = devices.find(x=>x.id===id);
        if (d) {
            document.getElementById('d-name').value = d.name;
            document.getElementById('d-ip').value = d.ip;
            document.getElementById('d-port').value = d.port;
            document.getElementById('d-area').value = d.area;
            document.getElementById('d-user').value = d.username;
            document.getElementById('d-pass').value = d.password;
            document.getElementById('d-note').value = d.note||'';
        }
    } else {
        ['d-name','d-ip','d-port','d-user','d-pass','d-note'].forEach(f=>document.getElementById(f).value='');
        if (areas.length) document.getElementById('d-area').value = areas[0];
    }
    openModal('devModal');
}

async function saveDevice() {
    const name = document.getElementById('d-name').value.trim();
    const ip = document.getElementById('d-ip').value.trim();
    if (!name||!ip) { toast('error','请填写设备名称和 IP 地址'); return; }
    const area = document.getElementById('d-area').value;
    if (!area) { toast('error','请选择区域'); return; }
    const obj = {
        name, ip,
        port: parseInt(document.getElementById('d-port').value) || 37777,
        area: area,
        username: document.getElementById('d-user').value || 'admin',
        password: document.getElementById('d-pass').value || '',
        note: document.getElementById('d-note').value || '',
    };
    let res;
    if (editDevId) {
        res = await updateDeviceToServer(editDevId, obj);
        if (res.code===0) toast('success', `设备「${name}」已更新`);
        else toast('error', `更新失败：${res.msg}`);
    } else {
        res = await addDeviceToServer(obj);
        if (res.code===0) toast('success', `设备「${name}」已添加`);
        else toast('error', `添加失败：${res.msg}`);
    }
    if (res.code===0) {
        closeModal('devModal');
        await loadDevicesFromServer();
    }
}

async function addDeviceToServer(device) {
    const resp = await fetch(`${API}/api/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(device)
    });
    return resp.json();
}

async function updateDeviceToServer(id, device) {
    const resp = await fetch(`${API}/api/devices/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(device)
    });
    return resp.json();
}

async function deleteDeviceFromServer(id) {
    const resp = await fetch(`${API}/api/devices/${id}`, { method: 'DELETE' });
    return resp.json();
}

async function confirmDelDev(id) {
    const d = devices.find(x=>x.id===id);
    if (!d) return;
    setConfirm('删除设备', `确定删除设备 <span class="confirm-hi">「${escapeHtml(d.name)}」</span>（${escapeHtml(d.ip)}）？相关人员数据将一并清除。`, async () => {
        const res = await deleteDeviceFromServer(id);
        if (res.code===0) {
            toast('success', `已删除设备「${d.name}」`);
            localStorage.removeItem(`dh_p_${id}`);
            localStorage.removeItem(`dh_total_${id}`);
            await loadDevicesFromServer();
        } else {
            toast('error', `删除失败：${res.msg}`);
        }
    });
}

// ========== 人员管理模块（全部使用服务端 persons.json）==========
let deviceUserPage = 1;
let deviceUserPageSize = 20;       // 本地分页每页条数
let currentViewMode = 'local';
let persons = [];

// ---------- 从服务端加载当前设备人员（本地数据） ----------
async function refreshPersonList(resetPage = true) {
    if (!currentPDevObj) return;
    try {
        const resp = await fetch(`${API}/api/persons?device_id=${currentPDevObj.id}`);
        const data = await resp.json();
        if (data.code === 0) {
            persons = data.data;
            if (resetPage) deviceUserPage = 1;
            renderPersonTable();
            updatePaginationUI();
        }
    } catch (e) {
        toast('error', '加载人员列表失败');
    }
}

// ---------- 加载全部设备的人员 ----------
async function loadAllPersons(resetPage = true) {
    try {
        const resp = await fetch(`${API}/api/persons`);
        const data = await resp.json();
        if (data.code === 0) {
            persons = data.data;
            if (resetPage) deviceUserPage = 1;
            renderPersonTable();
            updatePaginationUI();
        }
    } catch (e) {
        toast('error', '加载全部人员失败');
    }
}

// ---------- 渲染当前页的本地人员表格（支持搜索过滤）----------
function renderPersonTable(filter = '', customData = null) {
    const tbody = document.getElementById('personBody');
    let data = customData ? [...customData] : [...persons];
    if (filter) data = data.filter(p => (p.name + p.user_id).toLowerCase().includes(filter));

    let pageData;
    if (!customData) {
        const start = (deviceUserPage - 1) * deviceUserPageSize;
        const end = start + deviceUserPageSize;
        pageData = data.slice(start, end);
    } else {
        pageData = data;
    }

    if (!pageData.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>暂无人员</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = pageData.map(p => {
        // has_face 现在是设备级字典 {did: bool}，兼容旧格式
        const hf = p.has_face;
        const getDidFace = (did) => {
            if (hf && typeof hf === 'object') return hf[String(did)] === true;
            if (hf === true || hf === 'true' || hf === 1) return true; // 旧格式兼容
            if (hf === false || hf === 'false' || hf === 0) return false;
            return null;
        };
        const hasFace = currentPDevObj ? getDidFace(currentPDevObj.id) : null;
        // status 按设备读取
        const getDidStatus = (did) => {
            const s = p.status;
            if (s && typeof s === 'object') return s[String(did)] ?? 0;
            return typeof s === 'number' ? s : 0;
        };
        // 当前设备/全部设备的显示 status
        let displayStatus;
        if (currentPDevObj) {
            displayStatus = getDidStatus(currentPDevObj.id);
        } else {
            // 全部设备：有任意设备冻结就算冻结
            const myIds = new Set(devices.map(d => String(d.id)));
            displayStatus = p.status && typeof p.status === 'object'
                ? ([...myIds].some(id => (p.status[id] ?? 0) !== 0) ? 1 : 0)
                : (typeof p.status === 'number' ? p.status : 0);
        }
        // 录入人脸按钮：具体设备缺脸/未知显示；全部设备时0台有脸才显示
        let showFaceBtn;
        if (currentPDevObj) {
            showFaceBtn = hasFace !== true;
        } else {
            if (hf && typeof hf === 'object') {
                const myIds = new Set(devices.map(d => String(d.id)));
                showFaceBtn = myIds.size > 0 && ![...myIds].some(id => hf[id] === true);
            } else {
                showFaceBtn = !(hf === true || hf === 'true' || hf === 1);
            }
        }
        let faceHtml = '';
        if (hasFace === true) faceHtml = '<span class="badge bb">已录入</span>';
        else if (hasFace === false) faceHtml = '<span class="badge bgr">未录入</span>';
        else if (hf && typeof hf === 'object') {
            const myDeviceIds = new Set(devices.map(d => String(d.id)));
            const cnt = Object.entries(hf).filter(([did, v]) => v && myDeviceIds.has(did)).length;
            faceHtml = cnt > 0 ? `<span class="badge bb">${cnt}台</span>` : '<span class="badge bgr">未录入</span>';
        } else if (hf === true || hf === 'true' || hf === 1) {
            faceHtml = '<span class="badge bb">已录入</span>';  // 旧格式
        } else if (hf === false || hf === 'false' || hf === 0) {
            faceHtml = '<span class="badge bgr">未录入</span>'; // 旧格式
        } else faceHtml = '<span class="badge by">未知</span>';

        return `
        <tr>
            <td><span class="mono">${escapeHtml(p.user_id)}</span></td>
            <td><strong style="color:var(--text)">${escapeHtml(p.name)}</strong></td>
            <td><span class="mono" style="font-size:11.5px">${escapeHtml(safeDate(p.valid_end, '—'))}</span></td>
            <td><span class="badge ${displayStatus === 0 ? 'bg' : 'br'}">${displayStatus === 0 ? '正常' : '冻结'}</span></td>
            <td>${faceHtml}</td>
            <td><div class="dev-actions">
                <button class="btn btn-ghost btn-sm" onclick="openPersonModal('${escapeHtml(p.user_id)}')">编辑</button>
                ${displayStatus === 0
                    ? `<button class="btn btn-freeze btn-sm" onclick="togglePersonFreeze('${escapeHtml(p.user_id)}', true)">冻结</button>`
                    : `<button class="btn btn-blue btn-sm" onclick="togglePersonFreeze('${escapeHtml(p.user_id)}', false)">解冻</button>`}
                ${showFaceBtn ? `<button class="btn btn-blue btn-sm" onclick="openFaceModal('${escapeHtml(p.user_id)}')">录入人脸</button>` : ''}
                <button class="btn btn-danger btn-sm" onclick="confirmDelPerson('${escapeHtml(p.user_id)}')">删除</button>
            </div></td>
        </tr>`;
    }).join('');
}

// ---------- 设备选择框填充 ----------
function fillPersonDevSel() {
    const sel = document.getElementById('personDevSel');
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- 全部设备 --</option>';
    devices.forEach(d => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = `${d.name}  (${d.ip})`;
        sel.appendChild(o);
    });
    if (prev && devices.some(d => d.id == prev)) sel.value = prev;
    else sel.value = '';
}

// ---------- 切换设备时自动加载该设备的人员 ----------
function onPersonDeviceChange() {
    const devId = parseInt(document.getElementById('personDevSel').value);
    currentPDevObj = devices.find(d => d.id === devId) || null;
    const badge = document.getElementById('personDevBadge');
    document.getElementById('personContent').style.display = 'block';
    document.getElementById('personPH').style.display = 'none';
    currentViewMode = 'local';
    document.getElementById('searchUserId').value = '';
    document.getElementById('searchUserName').value = '';

    if (!currentPDevObj) {
        badge.innerHTML = '<span class="badge bg">全部设备</span>';
        loadAllPersons();
        return;
    }

    badge.innerHTML = `<span class="badge bb">已选择</span>`;
    // 加载人员列表，并恢复分页总数（优先使用缓存，否则用本地人数）
    refreshPersonList().then(() => {
        const cachedTotal = localStorage.getItem(`dh_total_${currentPDevObj.id}`);
        deviceUserTotal = cachedTotal ? parseInt(cachedTotal) : persons.length;
        deviceUserPage = 1;
        updatePaginationUI();
    });
}

// ---------- 分页加载设备人员（自动导入到服务端）----------
async function loadDeviceUsersPage(page) {
    if (!currentPDevObj) { toast('error', '请先选择设备'); return; }

    const btn = event?.target;
    const originalText = btn ? btn.innerHTML : '📥 加载设备人员';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 加载中';
    }

    try {
        const params = new URLSearchParams({
            device_ip: currentPDevObj.ip,
            device_port: currentPDevObj.port,
            username: currentPDevObj.username,
            password: currentPDevObj.password,
            page: page,
            page_size: deviceUserPageSize
        });
        const resp = await fetch(`${API}/api/device/users/all?${params}`);
        const data = await resp.json();

        if (data.code === 0 && data.data) {
            const total = data.data.total;
            const users = data.data.items;

            // 保存总数和页码
            localStorage.setItem(`dh_total_${currentPDevObj.id}`, total);
            deviceUserTotal = total;
            deviceUserPage = page;

            // 导入当前页到本地（不传has_face）
            const personsToImport = users.map(u => ({
                user_id: u.user_id,
                name: u.name,
                valid_begin: safeDate(u.valid_begin, '2000-01-01'),
                valid_end: safeDate(u.valid_end, '2037-12-31'),
                status: u.status || 0
            }));

            await fetch(`${API}/api/persons/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: currentPDevObj.id, persons: personsToImport })
            });

            // 刷新全局人员列表
            await refreshPersonList(false);

            // 从全局persons中筛选出当前页的用户
            const userIds = users.map(u => u.user_id);
            const pageData = persons.filter(p => userIds.includes(p.user_id));

            // 只显示当前页数据
            renderPersonTable('', pageData);
            updatePaginationUI();

            toast('success', `第 ${page} 页，共 ${total} 人`);
        } else {
            toast('error', data.msg || '加载失败');
        }
    } catch (e) {
        console.error(e);
        toast('error', '网络错误');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// ---------- 分页控件更新（基于 persons 总长度）----------
function updatePaginationUI() {
    const total = persons.length;
    const totalPages = Math.ceil(total / deviceUserPageSize) || 1;
    document.getElementById('personTotal').textContent = total;
    document.getElementById('personCurrentPage').textContent = deviceUserPage;
    document.getElementById('personTotalPages').textContent = totalPages;
    document.getElementById('personPrevBtn').disabled = (deviceUserPage <= 1);
    document.getElementById('personNextBtn').disabled = (deviceUserPage >= totalPages);
}

// 本地翻页
function prevPersonPage() {
    const totalPages = Math.ceil(persons.length / deviceUserPageSize);
    if (deviceUserPage > 1) {
        deviceUserPage--;
        renderPersonTable();
        updatePaginationUI();
    }
}
function nextPersonPage() {
    const totalPages = Math.ceil(persons.length / deviceUserPageSize);
    if (deviceUserPage < totalPages) {
        deviceUserPage++;
        renderPersonTable();
        updatePaginationUI();
    }
}
function jumpPersonPage() {
    const input = document.getElementById('personJumpPage');
    const page = parseInt(input.value);
    const totalPages = Math.ceil(persons.length / deviceUserPageSize);
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
        deviceUserPage = page;
        renderPersonTable();
        updatePaginationUI();
    }
    input.value = '';
}
function changePageSize() {
    deviceUserPageSize = parseInt(document.getElementById('personPageSize').value);
    deviceUserPage = 1;  // 重置到第一页
    renderPersonTable();
    updatePaginationUI();
}

// ---------- 一次性加载设备全部人员并更新到本地文件 ----------
async function loadAllDeviceUsers() {
    if (!currentPDevObj) { toast('error', '请先选择设备'); return; }

    const btn = event?.target;
    const originalText = btn ? btn.innerHTML : '📥 加载设备人员';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 加载中';
    }

    try {
        const params = new URLSearchParams({
            device_ip: currentPDevObj.ip,
            device_port: currentPDevObj.port,
            username: currentPDevObj.username,
            password: currentPDevObj.password,
            page: 1,
            page_size: 0   // 0 表示获取全部（后端需支持）
        });
        const resp = await fetch(`${API}/api/device/users/all?${params}`);
        const data = await resp.json();

        if (data.code === 0 && data.data) {
            const users = data.data.items;
            // 构造要导入的人员数组
            const personsToImport = users.map(u => ({
                user_id: u.user_id,
                name: u.name,
                valid_begin: safeDate(u.valid_begin, '2000-01-01'),
                valid_end: safeDate(u.valid_end, '2037-12-31'),
                status: u.status || 0
            }));
            // 调用导入接口，合并到公用人库
            await fetch(`${API}/api/persons/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: currentPDevObj.id, persons: personsToImport })
            });

            // 刷新本地列表
            await refreshPersonList(false);
            toast('success', `已加载 ${users.length} 名人员并更新本地数据`);
        } else {
            toast('error', data.msg || '加载失败');
        }
    } catch (e) {
        console.error(e);
        toast('error', '网络错误');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}


// ---------- 搜索功能 ----------
async function searchById() {
    const userId = document.getElementById('searchUserId').value.trim();
    if (!userId) { toast('error', '请输入用户ID'); return; }

    // 全部设备模式：从本地 persons 数组查找
    if (!currentPDevObj) {
        const matched = persons.find(p => p.user_id === userId);
        if (matched) {
            renderPersonTable('', [matched]);
            toast('success', `本地找到：${matched.name} (${matched.user_id})`);
        } else {
            renderPersonTable('', []);
            toast('error', '本地未找到该用户');
        }
        return;
    }

    // 具体设备模式：从设备端查找（结果自动导入到服务端）
    const btn = event.target;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 搜索中';

    try {
        const params = new URLSearchParams({
            device_ip: currentPDevObj.ip,
            device_port: currentPDevObj.port,
            username: currentPDevObj.username,
            password: currentPDevObj.password
        });
        const url = `${API}/api/device/user/id/${encodeURIComponent(userId)}?${params}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.code === 0 && data.data) {
            // 设备上存在该用户：导入并显示
            const u = data.data;
            await fetch(`${API}/api/persons/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: currentPDevObj.id,
                    persons: [{
                        user_id: u.user_id,
                        name: u.name,
                        valid_begin: safeDate(u.valid_begin, '2000-01-01'),
                        valid_end: safeDate(u.valid_end, '2037-12-31'),
                        status: u.status || 0
                    }]
                })
            });

            await refreshPersonList(false);
            const localPerson = persons.find(p => p.user_id === userId);
            if (localPerson) {
                renderPersonTable('', [localPerson]);
                toast('success', `当前设备存在用户：${localPerson.name} (${localPerson.user_id})`);
            } else {
                toast('error', '未找到该用户（可能数据同步异常）');
            }
        } else {
            // 设备上未找到该用户：检查本地是否有关联，若有则移除
            const cachedPerson = persons.find(p => p.user_id === userId);
            if (cachedPerson && cachedPerson.doors && cachedPerson.doors.includes(currentPDevObj.id)) {
                // 从当前设备移除关联
                await fetch(`${API}/api/persons/${userId}/devices/${currentPDevObj.id}`, { method: 'DELETE' });
                await refreshPersonList(false);
            } else {
                toast('error', data.msg || '当前设备未找到该用户');
            }
        }
    } catch (e) {
        console.error(e);
        toast('error', '搜索失败，请检查网络');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function searchByName() {
    const keyword = document.getElementById('searchUserName').value.trim();
    if (!keyword) { toast('error', '请输入姓名关键词'); return; }

    // 全部设备模式：从本地 persons 数组查找
    if (!currentPDevObj) {
        const kw = keyword.toLowerCase();
        const matched = persons.filter(p => p.name.toLowerCase().includes(kw));
        if (matched.length > 0) {
            renderPersonTable('', matched);
            toast('success', `本地找到 ${matched.length} 条匹配记录`);
        } else {
            renderPersonTable('', []);
            toast('error', '本地未找到匹配人员');
        }
        return;
    }

    // 具体设备模式：从设备端查找（结果自动导入到服务端）
    const btn = event.target;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 搜索中';

    try {
        const params = new URLSearchParams({
            device_ip: currentPDevObj.ip,
            device_port: currentPDevObj.port,
            username: currentPDevObj.username,
            password: currentPDevObj.password,
            keyword: keyword
        });
        const resp = await fetch(`${API}/api/device/users/search?${params}`);
        const data = await resp.json();

        if (data.code === 0 && data.data.items.length > 0) {
            const users = data.data.items.map(u => ({
                user_id: u.user_id,
                name: u.name,
                valid_begin: safeDate(u.valid_begin, '2000-01-01'),
                valid_end: safeDate(u.valid_end, '2037-12-31'),
                status: u.status || 0
            }));

            // 导入到本地
            await fetch(`${API}/api/persons/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: currentPDevObj.id, persons: users })
            });

            // 重新加载当前设备的所有人员
            await refreshPersonList(false);

            // 从全局persons中筛选出匹配的用户
            const matchedPersons = persons.filter(p =>
                users.some(u => u.user_id === p.user_id)
            );

            if (matchedPersons.length > 0) {
                renderPersonTable('', matchedPersons);
                toast('success', `找到 ${matchedPersons.length} 条匹配记录`);
            } else {
                toast('error', '未能加载匹配的用户信息');
            }
        } else {
            toast('error', data.msg || '未找到匹配人员');
        }
    } catch (e) {
        console.error(e);
        toast('error', '搜索失败，请检查网络');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function showAllLocalPersons() {
    // 清空搜索框
    document.getElementById('searchUserId').value = '';
    document.getElementById('searchUserName').value = '';
    // 全部设备：重新加载本地全部人员
    if (!currentPDevObj) {
        loadAllPersons();
        return;
    }
    // 具体设备：重新加载当前设备的全部人员（从本地 persons.json）
    refreshPersonList();   // 这会重置分页并渲染完整列表
}

// ---------- 批量添加人员----------
async function handleBatchFolder(files) {
    if (!files.length) return;
    const formData = new FormData();
    for (let f of files) formData.append('files', f);

    const btn = document.querySelector('.btn-blue[onclick*="batchFolderInput"]');
    const origText = btn ? btn.innerHTML : '📂 批量导入';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 导入中...'; }

    try {
        const resp = await fetch(`${API}/api/batch_import`, { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.code === 0) {
            const r = data.data;
            let resultHtml = `<div style="margin-bottom:16px;color:var(--text2);">
                <p>📊 处理：${r.total} 条 | ✅ 成功：${r.success} 人 | ❌ 失败：${r.fail} 条</p>
                <p>📷 人脸下发：成功 ${r.face_success || 0} / 失败 ${r.face_fail || 0}</p>
            </div>`;
            if (r.details && r.details.length > 0) {
                resultHtml += `<div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
                    <table style="width:100%;font-size:12px;color:var(--text2);">
                        <thead><tr><th>姓名</th><th>用户编号</th><th>目标门</th><th>添加结果</th><th>人脸下发</th></tr></thead><tbody>`;
                r.details.forEach(d => {
                    const statusColor = d.status === '成功' ? 'var(--accent2)' : (d.status === '失败' ? 'var(--red2)' : 'var(--yellow2)');
                    const faceColor = d.face_result.includes('成功') && !d.face_result.includes('部分') ? 'var(--accent2)' : (d.face_result === '失败' ? 'var(--red2)' : 'var(--text2)');
                    resultHtml += `<tr style="border-bottom:1px solid var(--border);">
                        <td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.user_id)}</td><td>${escapeHtml(d.doors)}</td>
                        <td style="color:${statusColor}">${d.status}</td><td style="color:${faceColor}">${d.face_result}</td></tr>`;
                });
                resultHtml += '</tbody></table></div>';
            }
            showResultModal('批量导入结果', resultHtml, async () => {
                if (currentPDevObj) { await refreshPersonList(); } else { await loadAllPersons(); }
            });
        } else {
            showResultModal('批量导入结果', `<p style="color:var(--red2);">导入失败：${escapeHtml(data.msg || '未知错误')}</p>`, null);
        }
    } catch (e) {
        showResultModal('批量导入结果', '<p style="color:var(--red2);">网络请求失败，请检查服务器</p>', null);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origText; }
        document.getElementById('batchFolderInput').value = '';
    }
}

function downloadTemplate() {
    window.open(`${API}/download/template`, '_blank');
}

// ---------- 添加人员（支持多选设备）----------
function fillPersonDeviceSelect() {
    const container = document.getElementById('device-checkbox-list');
    if (!container) return;
    container.innerHTML = '';
    devices.forEach(d => {
        const label = document.createElement('label');
        label.style.display = 'flex'; label.style.alignItems = 'center'; label.style.gap = '8px';
        label.style.padding = '6px 0'; label.style.cursor = 'pointer'; label.style.borderBottom = '1px solid var(--border)';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = d.id; cb.style.accentColor = 'var(--accent)';
        const span = document.createElement('span');
        span.textContent = `${d.name} (${d.ip})`; span.style.fontSize = '13px'; span.style.color = 'var(--text)';
        label.appendChild(cb); label.appendChild(span);
        container.appendChild(label);
    });
    // 默认勾选当前设备
    if (currentPDevObj) {
        const cbs = container.querySelectorAll('input[type="checkbox"]');
        cbs.forEach(cb => {
            if (parseInt(cb.value) === currentPDevObj.id) cb.checked = true;
        });
    }
}

async function openPersonModal(uid = null) {
    if (!uid && !currentPDevObj && devices.length === 0) {
        toast('error', '请先添加设备');
        return;
    }
    editPersonId = uid;
    document.getElementById('personModalTitle').textContent = uid ? '编辑人员' : '添加人员';
    document.getElementById('p-id').disabled = !!uid;
    fillPersonDeviceSelect();

    const container = document.getElementById('device-checkbox-list');
    const checkboxes = container ? container.querySelectorAll('input[type="checkbox"]') : [];
    const uploadRow = document.getElementById('face-upload-row');
    const hintRow = document.getElementById('face-hint-row');

    if (uid) {
        // ---- 编辑模式：隐藏上传区，检测本地 faces 文件夹 ----
        if (uploadRow) uploadRow.style.display = 'none';
        let hasFace = false;
        try {
            const resp = await fetch(`${API}/api/face/${encodeURIComponent(uid)}/exists`);
            const data = await resp.json();
            hasFace = data.exists;
        } catch (e) { /* 网络错误，当作无照片 */ }
        if (hintRow) hintRow.style.display = hasFace ? 'none' : '';
        // 加载人员信息，并勾选其所属设备
        const p = persons.find(x => x.user_id === uid);
        if (p) {
            document.getElementById('p-id').value = p.user_id;
            document.getElementById('p-name').value = p.name;
            // 有效期只设置截止日期，不再设置 p-begin
            document.getElementById('p-end').value = safeDate(p.valid_end, '2037-12-31');
            checkboxes.forEach(cb => {
                cb.checked = p.doors && p.doors.includes(parseInt(cb.value));
            });
        }
    } else {
        // 新增模式：显示上传区，隐藏提示
        if (uploadRow) uploadRow.style.display = '';
        if (hintRow) hintRow.style.display = 'none';
        ['p-id', 'p-name'].forEach(f => document.getElementById(f).value = '');
        document.getElementById('p-face').value = '';   // 清空照片选择
        // 不再操作 p-begin
        document.getElementById('p-end').value = '2037-12-31';
        checkboxes.forEach(cb => {
            cb.checked = currentPDevObj && parseInt(cb.value) === currentPDevObj.id;
        });
    }
    openModal('personModal');
}

/**
 * 延迟保存：人脸上传完成后执行设备写入 + 本地更新 + 列表刷新
 * 由 submitFace() 在 isEditContext 成功后调用
 */
async function _finalizeEditSave(ps) {
    const { uid, name, validEnd, validBegin, onlineChecked, removedDoors,
            existingPerson, personPayload, getDevStatus, checked,
            devicesNeedFace, alreadyHasFace, faceSuccess, faceFail, offlineSkip,
            devicesAlreadySaved } = ps;

    let fs = faceSuccess, ff = faceFail, os = offlineSkip;
    try {
        if (!devicesAlreadySaved) {
            // 保存到设备
            for (const did of onlineChecked) {
                const dev = devices.find(d => d.id === did);
                if (!dev) continue;
                const deviceResult = await apiRequest('PUT', `/api/user/${encodeURIComponent(uid)}`, dev, {
                    name,
                    status: getDevStatus(did),
                    doors: [0],
                    valid_begin: validBegin,
                    valid_end: validEnd,
                });
                if (deviceResult.code !== 0) {
                    throw new Error(`设备 ${dev.name} 更新失败：${deviceResult.msg || '未知错误'}`);
                }
            }
            for (const did of removedDoors) {
                const dev = devices.find(d => d.id === did);
                if (!dev) continue;
                if (!dev.online) { os++; continue; }
                const removeResult = await apiRequest('DELETE', `/api/user/${encodeURIComponent(uid)}`, dev);
                if (removeResult.code !== 0) {
                    throw new Error(`设备 ${dev.name} 移除人员失败：${removeResult.msg || '未知错误'}`);
                }
            }

            // 更新本地 persons.json
            const localResp = await fetch(`${API}/api/persons/${encodeURIComponent(uid)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(personPayload)
            });
            const localData = await localResp.json();
            if (localData.code !== 0) {
                toast('error', localData.msg || '本地人员信息更新失败');
                return;
            }
        }

        // 成功消息
        let msg = `${editPersonId ? '编辑' : '新增'}人员成功`;
        if (fs > 0) msg += `，新下发人脸${fs}台`;
        if (ff > 0) msg += `，${ff}台下发失败`;
        if (alreadyHasFace > 0) msg += `，${alreadyHasFace}台设备已存在人脸`;
        if (os > 0) msg += `，${os}台离线设备已跳过`;
        toast('success', msg);

        // 刷新列表
        if (currentPDevObj) {
            if (checked.includes(currentPDevObj.id)) {
                await refreshPersonList(false);
            } else if (removedDoors.includes(currentPDevObj.id)) {
                await refreshPersonList(false);
            }
        } else {
            await loadAllPersons(false);
        }
    } catch (e) {
        console.error(e);
        toast('error', e?.message || '编辑人员失败，请检查设备连接或用户状态');
    }
}

async function savePerson() {
    const container = document.getElementById('device-checkbox-list');
    const checked = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
                        .map(cb => parseInt(cb.value));
    if (!checked.length) {
        toast('error', '请至少勾选一个设备');
        return;
    }

    const uid = document.getElementById('p-id').value.trim();
    const name = document.getElementById('p-name').value.trim();
    const validEnd = document.getElementById('p-end').value;
    if (!uid || !name) {
        toast('error', '请填写用户ID和姓名');
        return;
    }
    if (!validEnd) {
        toast('error', '请填写有效期截止日期');
        return;
    }

    const existingPerson = editPersonId ? getPersonById(editPersonId) : null;
    const originalDoors = Array.isArray(existingPerson?.doors) ? existingPerson.doors.map(Number) : [];
    const removedDoors = editPersonId ? originalDoors.filter(id => !checked.includes(id)) : [];
    const validBegin = safeDate(existingPerson?.valid_begin, '2000-01-01');
    const status = existingPerson?.status ?? {};  // 现在是 dict
    // 辅助：从 dict 取某设备的 status
    const getDevStatus = (did) => {
        if (typeof status === 'object' && status !== null) return status[String(did)] ?? 0;
        return typeof status === 'number' ? status : 0;
    };
    // 检查任意设备是否有脸（兼容旧 bool 格式和新 dict 格式）
    const hf = existingPerson?.has_face;
    const currentHasFace = hf && typeof hf === 'object'
        ? Object.values(hf).some(v => v)
        : (hf === true || hf === 'true' || hf === 1);
    console.log('[DEBUG] savePerson editPersonId=', editPersonId, 'existingPerson=', existingPerson);
    console.log('[DEBUG] has_face=', hf, 'currentHasFace=', currentHasFace);
    console.log('[DEBUG] originalDoors=', originalDoors, 'checked=', checked);

    // 编辑模式：无任何变更时直接跳过
    if (editPersonId && existingPerson) {
        const oldName = existingPerson.name || '';
        const oldEnd = safeDate(existingPerson.valid_end, '2037-12-31');
        const doorsSame = originalDoors.length === checked.length
            && originalDoors.every(d => checked.includes(d));
        if (name === oldName && doorsSame && validEnd === oldEnd) {
            toast('info', '信息未变更，无需保存');
            return;
        }
    }

    let faceSuccess = 0, faceFail = 0, alreadyHasFace = 0, offlineSkip = 0;

    // 过滤离线设备：离线的不加入 doors，也不操作
    const onlineChecked = checked.filter(did => {
        const dev = devices.find(d => d.id === did);
        return dev?.online !== false;
    });
    offlineSkip = checked.length - onlineChecked.length;

    const personPayload = {
        user_id: uid,
        name: name,
        valid_begin: validBegin,
        valid_end: validEnd,
        status: status,
        doors: onlineChecked
    };
    // 确保 status dict 中当前设备都有默认值 0
    if (typeof personPayload.status !== 'object' || personPayload.status === null) {
        personPayload.status = {};
    }
    for (const did of onlineChecked) {
        if (!(String(did) in personPayload.status)) {
            personPayload.status[String(did)] = 0;
        }
    }
    // BUG FIX: 清理移出设备的 has_face 条目
    if (editPersonId && existingPerson?.has_face && removedDoors.length > 0) {
        const cleanedFace = {...existingPerson.has_face};
        for (const did of removedDoors) {
            delete cleanedFace[String(did)];
        }
        personPayload.has_face = cleanedFace;
    }

    const btn = document.getElementById('personSaveBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';

    try {
        if (editPersonId) {
            for (const did of onlineChecked) {
                const dev = devices.find(d => d.id === did);
                if (!dev) continue;
                const deviceResult = await apiRequest('PUT', `/api/user/${encodeURIComponent(uid)}`, dev, {
                    name,
                    status: getDevStatus(did),
                    doors: [0],
                    valid_begin: validBegin,
                    valid_end: validEnd,
                });
                if (deviceResult.code !== 0) {
                    throw new Error(`设备 ${dev.name} 更新失败：${deviceResult.msg || '未知错误'}`);
                }
            }
            for (const did of removedDoors) {
                const dev = devices.find(d => d.id === did);
                if (!dev) continue;
                if (!dev.online) { offlineSkip++; continue; }
                const removeResult = await apiRequest('DELETE', `/api/user/${encodeURIComponent(uid)}`, dev);
                if (removeResult.code !== 0) {
                    throw new Error(`设备 ${dev.name} 移除人员失败：${removeResult.msg || '未知错误'}`);
                }
            }

            const localResp = await fetch(`${API}/api/persons/${encodeURIComponent(uid)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(personPayload)
            });
            const localData = await localResp.json();
            if (localData.code !== 0) {
                toast('error', localData.msg || '本地人员信息更新失败');
                return;
            }

            // 对所有勾选设备中缺脸的设备下发（不论新旧）
            const hf2 = existingPerson?.has_face || {};
            const devicesNeedFace = onlineChecked.filter(did => !hf2[did]);
            alreadyHasFace = onlineChecked.length - devicesNeedFace.length;
            console.log('[DEBUG] checked=', checked, 'has_face=', hf2, 'devicesNeedFace=', devicesNeedFace);
            if (devicesNeedFace.length > 0) {
                let hasLocalFace = false;
                try {
                    const faceResp = await fetch(`${API}/api/face/${encodeURIComponent(uid)}`);
                    console.log('[DEBUG] GET face cache status=', faceResp.status, 'ok=', faceResp.ok);
                    if (faceResp.ok) {
                        hasLocalFace = true;
                        const faceBlob = await faceResp.blob();
                        console.log('[DEBUG] faceBlob size=', faceBlob.size);
                        for (const did of devicesNeedFace) {
                            const dev = devices.find(d => d.id === did);
                            if (!dev) { faceFail++; continue; }
                            const fd = new FormData();
                            fd.append('file', faceBlob, `${uid}.jpg`);
                            fd.append('force', '1');
                            fd.append('device_ip', dev.ip);
                            fd.append('device_port', dev.port);
                            fd.append('username', dev.username);
                            fd.append('password', dev.password);
                            try {
                                const devRes = await fetch(`${API}/api/face/${uid}`, { method: 'POST', body: fd });
                                const devResult = await devRes.json();
                                console.log('[DEBUG] POST face to dev', did, dev.name, 'result=', devResult.code, devResult.msg);
                                if (devResult.code === 0) { faceSuccess++; }
                                else { faceFail++; }
                            } catch (e) { faceFail++; console.error('[DEBUG] POST face error', did, e); }
                        }
                    }
                } catch (e) { /* 获取缓存失败，无本地照片 */ }
                if (!hasLocalFace) {
                    // 无本地照片 → 暂存上下文，弹窗上传人脸，由 submitFace 回调 _finalizeEditSave
                    _pendingPersonSave = {
                        uid, name, validEnd, validBegin, onlineChecked, removedDoors,
                        existingPerson, personPayload, getDevStatus, checked,
                        devicesNeedFace, alreadyHasFace, faceSuccess: 0, faceFail: 0, offlineSkip,
                        devicesAlreadySaved: true
                    };
                    closeModal('personModal');
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                    openFaceModal(uid, devicesNeedFace);
                    return;
                }
            }
        } else {
            for (const did of onlineChecked) {
                const dev = devices.find(d => d.id === did);
                if (!dev) continue;
                const createResult = await apiRequest('POST', '/api/user', dev, { user_id: uid, name });
                if (createResult.code !== 0) {
                    throw new Error(`设备 ${dev.name} 新增人员失败：${createResult.msg || '未知错误'}`);
                }
            }

            const importResp = await fetch(`${API}/api/persons/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: checked[0], persons: [personPayload] })
            });
            const importData = await importResp.json();
            if (importData.code !== 0) {
                toast('error', importData.msg || '本地人员信息写入失败');
                return;
            }

            // ---- 新增人员时自动下发人脸照片 ----
            const faceFileInput = document.getElementById('p-face');
            if (faceFileInput && faceFileInput.files.length > 0) {
                const faceFile = faceFileInput.files[0];
                const fd = new FormData();
                fd.append('file', faceFile);
                fd.append('force', '1');
                for (const did of onlineChecked) {
                    const dev = devices.find(d => d.id === did);
                    if (!dev) { faceFail++; continue; }
                    fd.set('device_ip', dev.ip);
                    fd.set('device_port', dev.port);
                    fd.set('username', dev.username);
                    fd.set('password', dev.password);
                    try {
                        const faceResp = await fetch(`${API}/api/face/${encodeURIComponent(uid)}`, { method: 'POST', body: fd });
                        const faceData = await faceResp.json();
                        if (faceData.code === 0) { faceSuccess++; }
                        else { faceFail++; }
                    } catch (e) { faceFail++; }
                }
            }
        }

        let msg = editPersonId
            ? `人员「${name}」信息已更新`
            : `人员「${name}」已添加到 ${onlineChecked.length} 个设备`;
        if (editPersonId && removedDoors.length > 0) {
            msg += `，已移出 ${removedDoors.length} 个设备`;
        }
        if (alreadyHasFace > 0) {
            msg += `，${alreadyHasFace}台设备已存在人脸`;
        }
        if (faceSuccess > 0) {
            msg += `，新下发人脸${faceSuccess}台`;
        }
        if (faceFail > 0) {
            msg += `，${faceFail}台下发失败`;
        }
        if (offlineSkip > 0) {
            msg += `，${offlineSkip}台离线设备已跳过`;
        }
        toast('success', msg);
        closeModal('personModal');

        if (currentPDevObj) {
            if (checked.includes(currentPDevObj.id)) {
                await refreshPersonList(false);
                if (!editPersonId) {
                    const idx = persons.findIndex(p => p.user_id === uid);
                    if (idx > -1) {
                        const newUser = persons.splice(idx, 1)[0];
                        persons.unshift(newUser);
                    }
                    deviceUserPage = 1;
                    renderPersonTable();
                    updatePaginationUI();
                }
            } else if (editPersonId && removedDoors.includes(currentPDevObj.id)) {
                await refreshPersonList(false);
            }
        } else {
            await loadAllPersons(false);
        }
    } catch (e) {
        console.error(e);
        toast('error', e?.message || (editPersonId ? '编辑人员失败，请检查设备连接或用户状态' : '操作失败，请检查设备连接'));
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

function getPersonById(uid) {
    return persons.find(x => x.user_id === uid) || null;
}

function openValidityModal(uid) {
    if (!currentPDevObj) {
        toast('error', '请先选择设备');
        return;
    }
    const person = getPersonById(uid);
    if (!person) {
        toast('error', '未找到人员信息');
        return;
    }
    document.getElementById('validityUid').textContent = uid;
    document.getElementById('validity-begin').value = safeDate(person.valid_begin, '2000-01-01');
    document.getElementById('validity-end').value = safeDate(person.valid_end, '2037-12-31');
    openModal('validityModal');
}

async function submitValidityUpdate() {
    if (!currentPDevObj) {
        toast('error', '请先选择设备');
        return;
    }

    const uid = document.getElementById('validityUid').textContent.trim();
    const validBegin = document.getElementById('validity-begin').value;
    const validEnd = document.getElementById('validity-end').value;
    if (!uid || !validBegin || !validEnd) {
        toast('error', '请完整填写有效期');
        return;
    }
    if (validBegin > validEnd) {
        toast('error', '开始日期不能晚于截止日期');
        return;
    }

    const btn = document.getElementById('validitySaveBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';

    try {
        const result = await apiRequest('PUT', `/api/user/${encodeURIComponent(uid)}/validity`, currentPDevObj, {
            valid_begin: validBegin,
            valid_end: validEnd
        });
        if (result.code !== 0) {
            toast('error', result.msg || '有效期更新失败');
            return;
        }

        const localResp = await fetch(`${API}/api/persons/${encodeURIComponent(uid)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ valid_begin: validBegin, valid_end: validEnd })
        });
        const localData = await localResp.json();
        if (localData.code !== 0) {
            toast('error', localData.msg || '本地数据更新失败');
            return;
        }

        toast('success', `人员「${uid}」有效期已更新`);
        closeModal('validityModal');
        await refreshPersonList(false);
    } catch (e) {
        console.error(e);
        toast('error', '更新有效期失败，请检查设备连接');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function togglePersonFreeze(uid, shouldFreeze) {
    const person = getPersonById(uid);
    if (!person) {
        toast('error', '未找到人员信息');
        return;
    }

    const actionText = shouldFreeze ? '冻结' : '解冻';
    const path = shouldFreeze ? `/api/user/${encodeURIComponent(uid)}/freeze` : `/api/user/${encodeURIComponent(uid)}/unfreeze`;

    // 全部设备模式：冻结/解冻，显示设备选择框（默认全选）
    if (!currentPDevObj) {
        const personDoors = person.doors || [];
        const targetDevs = personDoors.map(did => devices.find(d => d.id === did)).filter(Boolean);
        if (targetDevs.length === 0) {
            toast('error', '该人员没有关联任何设备');
            return;
        }
        const checkboxes = targetDevs.map(d =>
            `<label style="display:block;margin:2px 0;cursor:pointer;"><input type="checkbox" name="freezeDevs" value="${d.id}" checked> ${escapeHtml(d.name)}（${escapeHtml(d.ip)}）</label>`
        ).join('');
        setConfirm(
            `${actionText}人员`,
            `确定要${actionText}人员 <span class="confirm-hi">「${escapeHtml(person.name)}」</span>（ID: ${escapeHtml(uid)}）吗？<br><br>选择目标设备：<div style="margin-top:6px;text-align:left;max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;">${checkboxes}</div>`,
            async () => {
                const checkedBoxes = document.querySelectorAll('input[name="freezeDevs"]:checked');
                if (checkedBoxes.length === 0) { toast('error', '请至少选择一个设备'); return; }
                let success = 0, fail = 0;
                for (const cb of checkedBoxes) {
                    const did = parseInt(cb.value);
                    const dev = devices.find(d => d.id === did);
                    if (!dev) { fail++; continue; }
                    try {
                        const result = await apiRequest('POST', path, dev);
                        if (result.code === 0) { success++; }
                        else { fail++; toast('error', `设备「${dev.name}」${actionText}失败：${result.msg}`); }
                    } catch (e) { fail++; toast('error', `设备「${dev.name}」网络错误`); }
                }
                if (success > 0) {
                    const newStatus = shouldFreeze ? 1 : 0;
                    // status 按设备存储
                    const statusPayload = {};
                    for (const cb of checkedBoxes) {
                        statusPayload[String(parseInt(cb.value))] = newStatus;
                    }
                    await fetch(`${API}/api/persons/${encodeURIComponent(uid)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: statusPayload })
                    });
                    toast('success', `已完成：${success} 成功，${fail} 失败`);
                    loadAllPersons(false);
                } else {
                    toast('error', '所有操作均失败');
                }
            }
        );
        return;
    }

    setConfirm(
        `${actionText}人员`,
        `确定要${actionText}人员 <span class="confirm-hi">「${escapeHtml(person.name)}」</span>（ID: ${escapeHtml(uid)}）吗？<br>目标设备：${escapeHtml(currentPDevObj.name)}（${escapeHtml(currentPDevObj.ip)}）`,
        async () => {
            try {
                const result = await apiRequest('POST', path, currentPDevObj);
                if (result.code !== 0) {
                    toast('error', result.msg || `${actionText}失败`);
                    return;
                }

                const newStatus = shouldFreeze ? 1 : 0;
                const statusPayload = { [String(currentPDevObj.id)]: newStatus };
                const localResp = await fetch(`${API}/api/persons/${encodeURIComponent(uid)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: statusPayload })
                });
                const localData = await localResp.json();
                if (localData.code !== 0) {
                    toast('error', localData.msg || '本地状态更新失败');
                    return;
                }

                toast('success', `已${actionText}人员「${person.name}」`);
                await refreshPersonList(false);
            } catch (e) {
                console.error(e);
                toast('error', `${actionText}失败，请检查设备连接`);
            }
        }
    );
}

// ---------- 删除人员 ----------
async function confirmDelPerson(uid) {
    const p = persons.find(x => x.user_id === uid);
    if (!p) return;

    // 获取当前用户拥有的所有设备ID
    let userDeviceIds = [];
    try {
        const resp = await fetch(`${API}/api/devices`);
        const data = await resp.json();
        if (data.code === 0) userDeviceIds = data.data.map(d => d.id);
    } catch (e) { toast('error', '获取设备列表失败'); return; }

    const personDoors = p.doors || [];
    // 交集：只有当前用户拥有的设备才允许操作
    const allowedDevices = personDoors.filter(did => userDeviceIds.includes(did));

    if (allowedDevices.length === 0) {
        toast('error', '该人员没有关联您管理的设备');
        return;
    }

    // 全部设备模式：显示设备选择框（默认全选）
    if (!currentPDevObj) {
        const devCheckboxes = allowedDevices.map(did => {
            const dev = devices.find(d => d.id === did);
            const label = dev ? `${escapeHtml(dev.name)}（${escapeHtml(dev.ip)}）` : `设备${did}`;
            return `<label style="display:block;margin:2px 0;cursor:pointer;"><input type="checkbox" name="delDevs" value="${did}" checked> ${label}</label>`;
        }).join('');
        setConfirm('删除人员', `确定删除人员「${escapeHtml(p.name)}」（ID: ${uid}）？<br><br>选择目标设备：<div style="margin-top:6px;text-align:left;max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;">${devCheckboxes}</div>`, async () => {
            const checkedBoxes = document.querySelectorAll('input[name="delDevs"]:checked');
            if (checkedBoxes.length === 0) { toast('error', '请至少选择一个设备'); return; }
            let success = 0, fail = 0;
            for (const cb of checkedBoxes) {
                const did = parseInt(cb.value);
                const dev = devices.find(d => d.id === did);
                if (!dev) { fail++; continue; }
                try {
                    const hwResult = await apiRequest('DELETE', `/api/user/${uid}`, dev);
                    if (hwResult.code === 0) {
                        const resp = await fetch(`${API}/api/persons/${uid}/devices/${did}`, { method: 'DELETE' });
                        if (resp.ok) {
                            success++;
                            toast('success', `已从设备「${dev.name}」移除`);
                        } else { fail++; }
                    } else {
                        fail++;
                        toast('error', `设备「${dev.name}」删除失败：${hwResult.msg}`);
                    }
                } catch (e) {
                    fail++;
                    toast('error', `设备「${dev.name}」网络错误`);
                }
            }
            if (success > 0) {
                toast('success', `已完成：${success} 成功，${fail} 失败`);
            } else {
                toast('error', '所有操作均失败');
            }
            loadAllPersons(false);   // 重新加载全部设备人员
        });
        return;
    }

    const radioHtml = `
        <div style="margin-top:10px; text-align:left;">
            <label><input type="radio" name="delScope" value="current" checked> 仅从当前设备移除</label><br>
            <label><input type="radio" name="delScope" value="all"> 从我的所有关联设备删除</label>
        </div>`;

    setConfirm('删除人员', `确定对人员「${escapeHtml(p.name)}」（ID: ${uid}）执行删除？<br>您管理的关联设备：${allowedDevices.length} 台。${radioHtml}`, async () => {
        const scope = document.querySelector('input[name="delScope"]:checked').value;
        let targetDeviceIds = (scope === 'current') ? [currentPDevObj.id] : allowedDevices;
        // 确保目标设备在允许范围内
        targetDeviceIds = targetDeviceIds.filter(did => allowedDevices.includes(did));
        if (targetDeviceIds.length === 0) {
            toast('error', '没有可操作的设备');
            return;
        }

        let success = 0, fail = 0;
        for (const did of targetDeviceIds) {
            const dev = devices.find(d => d.id === did);
            if (!dev) { fail++; continue; }
            try {
                const hwResult = await apiRequest('DELETE', `/api/user/${uid}`, dev);
                if (hwResult.code === 0) {
                    const resp = await fetch(`${API}/api/persons/${uid}/devices/${did}`, { method: 'DELETE' });
                    if (resp.ok) {
                        success++;
                        toast('success', `已从设备「${dev.name}」移除`);
                    } else {
                        fail++;
                    }
                } else {
                    fail++;
                    toast('error', `设备「${dev.name}」删除失败：${hwResult.msg}`);
                }
            } catch (e) {
                fail++;
                toast('error', `设备「${dev.name}」网络错误`);
            }
        }

        if (success > 0) {
            toast('success', `已完成：${success} 成功，${fail} 失败`);
        } else {
            toast('error', '所有操作均失败');
        }
        await refreshPersonList(false);   // 重新加载当前设备人员
    });
}

async function updatePersonDoors(uid, newDoors) {
    // 如果 doors 为空，则完全删除该人员；否则更新 doors 数组
    if (newDoors.length === 0) {
        await fetch(`${API}/api/persons/${uid}`, { method: 'DELETE' });
    } else {
        await fetch(`${API}/api/persons/${uid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doors: newDoors })
        });
    }
}

// ---------- 人脸操作 ----------
function openFaceModal(uid, pendingDevices = null) {
    faceUid = uid;
    facePendingDevices = pendingDevices;
    document.getElementById('faceUid').textContent = uid;
    document.getElementById('faceFile').value = '';
    // 编辑场景预设100KB限制
    document.getElementById('face-kb').value = (pendingDevices && pendingDevices.length > 0) ? '100' : '0';
    openModal('faceModal');
}

async function submitFace() {
    const fi = document.getElementById('faceFile');
    if (!fi.files.length) { toast('error', '请选择图片'); return; }
    const btn = document.getElementById('faceBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 下发中';

    try {
        let doors, hf, isEditContext;
        if (facePendingDevices && facePendingDevices.length > 0) {
            // 编辑人员场景：只对指定设备下发
            doors = facePendingDevices;
            isEditContext = true;
            const resp = await fetch(`${API}/api/persons`);
            const data = await resp.json();
            const person = (data.code === 0 ? data.data : []).find(p => p.user_id === faceUid);
            hf = person?.has_face || {};
        } else {
            // 原有逻辑：获取该人员所属的所有设备
            isEditContext = false;
            const resp = await fetch(`${API}/api/persons`);
            const data = await resp.json();
            const person = (data.code === 0 ? data.data : []).find(p => p.user_id === faceUid);
            const doors2 = person ? (person.doors || []) : [];
            hf = person?.has_face || {};
            if (doors2.length === 0 && currentPDevObj) {
                // 如果没有关联设备，至少尝试当前设备
                doors2.push(currentPDevObj.id);
            }
            doors = doors2;
        }
        if (doors.length === 0) {
            toast('error', '该人员没有关联任何设备，请先选择设备');
            return;
        }

        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;

        for (const did of doors) {
            // 编辑场景强制下发，非编辑场景跳过已有脸
            if (!isEditContext && hf[did]) { skipCount++; continue; }

            const dev = devices.find(d => d.id === did);
            if (!dev) { failCount++; continue; }

            const fd = new FormData();
            fd.append('file', fi.files[0]);
            fd.append('max_kb', document.getElementById('face-kb').value || '0');
            fd.append('width', document.getElementById('face-w').value || '0');
            fd.append('height', document.getElementById('face-h').value || '0');
            fd.append('quality', document.getElementById('face-q').value || '0');
            fd.append('device_ip', dev.ip);
            fd.append('device_port', dev.port);
            fd.append('username', dev.username);
            fd.append('password', dev.password);
            if (isEditContext) { fd.append('force', '1'); }

            try {
                const devRes = await fetch(`${API}/api/face/${faceUid}`, { method: 'POST', body: fd });
                const devResult = await devRes.json();
                if (devResult.code === 0) {
                    successCount++;
                } else {
                    failCount++;
                    console.warn(`设备 ${dev.name} 失败: ${devResult.msg}`);
                }
            } catch (e) {
                failCount++;
                console.warn(`设备 ${dev.name} 网络错误`);
            }
        }

        if (successCount > 0 || skipCount > 0) {
            facePendingDevices = null;  // 清除编辑上下文
            // 后端已自动更新 has_face 设备级状态，无需前端再调 PUT

            // 如果是编辑人员时的延迟保存：人脸已上传，现在完成设备写入 + 本地更新
            if (_pendingPersonSave) {
                const ps = _pendingPersonSave;
                _pendingPersonSave = null;
                ps.faceSuccess = successCount;
                ps.faceFail = failCount;
                closeModal('faceModal');
                await _finalizeEditSave(ps);
                return;
            }

            // 重新加载人员列表并刷新表格
            if (currentPDevObj) { await refreshPersonList(false); } else { loadAllPersons(false); }

            let msgParts = [];
            if (successCount > 0) msgParts.push(`已下发 ${successCount} 台`);
            if (skipCount > 0) msgParts.push(`跳过 ${skipCount} 台（已有）`);
            if (failCount > 0) msgParts.push(`${failCount} 台失败`);
            toast('success', `人脸操作完成：${msgParts.join('，')}`);
            closeModal('faceModal');
        } else {
            toast('error', '所有设备下发均失败');
        }
    } catch (e) {
        console.error(e);
        toast('error', '网络错误');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '下发人脸';
    }
}

async function confirmDelFace(uid) {
    setConfirm('删除人脸', `确定删除用户 <span class="confirm-hi">「${uid}」</span> 的人脸吗？<br>将在所有关联设备上移除。`, async () => {
        try {
            // 获取该人员所属的所有设备
            const resp = await fetch(`${API}/api/persons`);
            const data = await resp.json();
            const person = (data.code === 0 ? data.data : []).find(p => p.user_id === uid);
            const doors = person ? (person.doors || []) : [];

            if (doors.length === 0) {
                toast('error', '该人员没有任何设备关联');
                return;
            }

            let successCount = 0;
            let failCount = 0;

            for (const did of doors) {
                const dev = devices.find(d => d.id === did);
                if (!dev) {
                    failCount++;
                    continue;
                }

                try {
                    const r = await apiRequest('DELETE', `/api/face/${uid}`, dev);
                    if (r.code === 0) {
                        successCount++;
                    } else {
                        failCount++;
                        console.warn(`设备 ${dev.name} 删除人脸失败: ${r.msg}`);
                    }
                } catch (e) {
                    failCount++;
                    console.warn(`设备 ${dev.name} 网络错误`);
                }
            }

            if (successCount > 0) {
                // 后端已自动更新 has_face 设备级状态
                toast('success', `人脸已从 ${successCount}/${doors.length} 台设备删除` + (failCount > 0 ? `，${failCount} 台失败` : ''));
                if (currentPDevObj) { await refreshPersonList(false); } else { loadAllPersons(false); }
            } else {
                toast('error', '所有设备删除均失败');
            }
        } catch (e) {
            toast('error', '网络错误');
        }
    });
}

// ========== 通用工具函数 ==========
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    // 取消人脸弹窗 → 放弃延迟保存
    if (id === 'faceModal') {
        _pendingPersonSave = null;
        facePendingDevices = null;
    }
    // 取消人员弹窗 → 清理延迟保存上下文，避免残留状态导致按钮异常
    if (id === 'personModal') {
        _pendingPersonSave = null;
    }
}
function setConfirm(title, html, cb) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').innerHTML = html;
    document.getElementById('confirmCancel').style.display = ''; // 确保取消按钮可见
    document.getElementById('confirmOk').onclick = () => { closeModal('confirmModal'); cb(); };
    document.getElementById('confirmOk').className = 'btn btn-danger';
    openModal('confirmModal');
}
function showResultModal(title, html, callback) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').innerHTML = html;
    document.getElementById('confirmCancel').style.display = 'none';
    const okBtn = document.getElementById('confirmOk');
    okBtn.textContent = '确定';
    okBtn.className = 'btn btn-primary';
    okBtn.onclick = function() {
        closeModal('confirmModal');
        document.getElementById('confirmCancel').style.display = '';
        okBtn.textContent = '确认';
        okBtn.className = 'btn btn-danger';
        if (callback) callback();
    };
    openModal('confirmModal');
}
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}
function toast(type, msg) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('tc').appendChild(el);
    setTimeout(() => el.remove(), 3100);
}

async function initMain() {
    // 快速加载areas（仅读本地JSON，毫秒级），页面秒开
    await loadAreas();
    // 立即渲染骨架（显示"正在加载设备…"旋转图标）
    renderAccessGrid();
    // 设备列表后台异步加载，不阻塞页面渲染
    loadDevicesFromServer();
    checkHealth();
    setInterval(checkHealth, 10000);
    const sel = document.getElementById('personDevSel');
    if (sel && sel.value) onPersonDeviceChange();
}

// ========== 管理员：用户管理模块 ==========
async function loadAdminUsers() {
    const tbody = document.getElementById('adminUserBody');
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px"><span class="spinner"></span> 加载中...</td></tr>`;
    try {
        const resp = await fetch(`${API}/api/admin/users`);
        const data = await resp.json();
        if (data.code !== 0) { tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>${escapeHtml(data.msg)}</p></div></td></tr>`; return; }
        const users = data.data;
        if (!users.length) { tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>暂无用户</p></div></td></tr>`; return; }

        // 获取每个用户的设备数量
        tbody.innerHTML = users.map(u => `
            <tr>
                <td><strong style="color:var(--text)">${escapeHtml(u.username)}</strong></td>
                <td><span class="badge ${u.role === 'admin' ? 'by' : 'bb'}">${u.role === 'admin' ? '🛡️ 管理员' : '👤 普通用户'}</span></td>
                <td><span class="mono" id="devcount-${escapeHtml(u.username)}">—</span></td>
                <td><div class="dev-actions">
                    <button class="btn btn-blue btn-sm" onclick="openAssignDevModal('${escapeHtml(u.username)}')">📡 分配设备</button>
                    <button class="btn btn-ghost btn-sm" onclick="openAdminUserModal('${escapeHtml(u.username)}', '${u.role}')">编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="confirmDeleteAdminUser('${escapeHtml(u.username)}')">删除</button>
                </div></td>
            </tr>
        `).join('');

        // 异步加载每个用户的设备数
        users.forEach(async u => {
            try {
                const r = await fetch(`${API}/api/admin/users/${encodeURIComponent(u.username)}/devices`);
                const d = await r.json();
                const el = document.getElementById(`devcount-${u.username}`);
                if (el && d.code === 0) el.textContent = d.data.length + ' 台';
            } catch(e) {}
        });
    } catch(e) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>加载失败，请刷新</p></div></td></tr>`;
    }
}

function openAdminUserModal(username = null, role = 'user') {
    adminEditUsername = username;
    const isEdit = !!username;
    document.getElementById('adminUserModalTitle').textContent = isEdit ? `编辑用户：${username}` : '新建用户';
    document.getElementById('au-username').value = username || '';
    document.getElementById('au-username').disabled = isEdit;
    document.getElementById('au-role').value = role;
    document.getElementById('au-password').value = '';
    document.getElementById('au-pass-hint').textContent = isEdit ? '（留空则不修改密码）' : '';
    openModal('adminUserModal');
}

async function saveAdminUser() {
    const username = document.getElementById('au-username').value.trim();
    const password = document.getElementById('au-password').value.trim();
    const role = document.getElementById('au-role').value;
    const isEdit = !!adminEditUsername;
    const btn = document.getElementById('adminUserSaveBtn');

    if (!isEdit && !username) { toast('error', '请填写用户名'); return; }
    if (!isEdit && !password) { toast('error', '请填写密码'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';
    try {
        let resp, data;
        if (isEdit) {
            const body = { role };
            if (password) body.password = password;
            resp = await fetch(`${API}/api/admin/users/${encodeURIComponent(adminEditUsername)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            data = await resp.json();
            if (data.code === 0) { toast('success', `用户「${adminEditUsername}」已更新`); closeModal('adminUserModal'); loadAdminUsers(); }
            else toast('error', data.msg || '更新失败');
        } else {
            resp = await fetch(`${API}/api/admin/users`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, role })
            });
            data = await resp.json();
            if (data.code === 0) { toast('success', `用户「${username}」已创建`); closeModal('adminUserModal'); loadAdminUsers(); }
            else toast('error', data.msg || '创建失败');
        }
    } catch(e) { toast('error', '网络错误'); }
    finally { btn.disabled = false; btn.innerHTML = '保存'; }
}

function confirmDeleteAdminUser(username) {
    setConfirm('删除用户', `确定删除用户 <span class="confirm-hi">「${escapeHtml(username)}」</span>？此操作不可恢复。`, async () => {
        try {
            const resp = await fetch(`${API}/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
            const data = await resp.json();
            if (data.code === 0) { toast('success', `用户「${username}」已删除`); loadAdminUsers(); }
            else toast('error', data.msg || '删除失败');
        } catch(e) { toast('error', '网络错误'); }
    });
}

async function openAssignDevModal(username) {
    assignTargetUsername = username;
    document.getElementById('assignTargetUser').textContent = username;
    const listEl = document.getElementById('assignDevList');
    listEl.innerHTML = '<span class="spinner"></span> 加载中…';
    openModal('assignDevModal');

    try {
        // 获取管理员自己的设备列表 和 目标用户已有的设备ID
        const [myDevResp, userDevResp] = await Promise.all([
            fetch(`${API}/api/devices`),
            fetch(`${API}/api/admin/users/${encodeURIComponent(username)}/devices`)
        ]);
        const myDevData = await myDevResp.json();
        const userDevData = await userDevResp.json();

        const myDevs = myDevData.code === 0 ? myDevData.data : [];
        const userDevIds = new Set(userDevData.code === 0 ? userDevData.data : []);

        if (!myDevs.length) { listEl.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:8px">您尚未添加任何设备</p>'; return; }

        listEl.innerHTML = '';
        myDevs.forEach(d => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 4px;cursor:pointer;border-bottom:1px solid var(--border)';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = d.id;
            cb.checked = userDevIds.has(d.id);
            cb.style.accentColor = 'var(--accent)';
            const info = document.createElement('span');
            info.innerHTML = `<span style="color:var(--text);font-size:13px">${escapeHtml(d.name)}</span> <span class="mono" style="font-size:11.5px">${escapeHtml(d.ip)}</span> <span class="badge bgr" style="font-size:10.5px">${escapeHtml(d.area)}</span>`;
            label.appendChild(cb);
            label.appendChild(info);
            listEl.appendChild(label);
        });
    } catch(e) { listEl.innerHTML = '<p style="color:var(--red2);font-size:13px;padding:8px">加载失败</p>'; }
}

async function saveAssignDevices() {
    if (!assignTargetUsername) return;
    const listEl = document.getElementById('assignDevList');
    const checked = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked')).map(cb => parseInt(cb.value));
    const all = Array.from(listEl.querySelectorAll('input[type=checkbox]')).map(cb => parseInt(cb.value));
    const unchecked = all.filter(id => !checked.includes(id));

    const btn = document.getElementById('assignDevSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';

    try {
        // 分配勾选的设备
        if (checked.length > 0) {
            const resp = await fetch(`${API}/api/admin/users/${encodeURIComponent(assignTargetUsername)}/devices`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_ids: checked })
            });
            const data = await resp.json();
            if (data.code !== 0) { toast('error', '分配失败：' + data.msg); return; }
        }

        // 取消勾选的设备：从目标用户设备列表中删除
        for (const did of unchecked) {
            await fetch(`${API}/api/admin/users/${encodeURIComponent(assignTargetUsername)}/devices/${did}`, { method: 'DELETE' });
        }

        toast('success', `设备分配已更新，共分配 ${checked.length} 台`);
        closeModal('assignDevModal');
        loadAdminUsers();
    } catch(e) { toast('error', '网络错误'); }
    finally { btn.disabled = false; btn.innerHTML = '保存分配'; }
}

checkLogin();