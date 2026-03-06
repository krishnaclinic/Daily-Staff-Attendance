/**
 * 1. CONFIGURATION - Update these with your real IDs
 */
const CLIENT_ID = '747138722746-5moie20nkh3hgpkrhfb4gmvmkiadjbku.apps.googleusercontent.com';
const API_KEY = 'AIzaSyA3v6zEyQhRq8X-PW0HG1eqhdmk8wbSg8s';
const SPREADSHEET_ID = '1UpHxRuvfYWguE78__bYR2sfjxRn6sskqOa5Po7XUoCU';
const OWNER_EMAIL = 'krishnahospitalsapotra@gmail.com'; // Admin account

const DISCOVERY_DOC = 'https://sheets.googleapis.com/$discovery/rest?version=v4';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';

let tokenClient, gisInited = false, gapiInited = false, accessToken = null;
let currentUser = null, currentStoreData = null, staffPhoto = null;

/**
 * 2. INITIALIZATION & AUTH
 */
async function initializeApp() {
    gapi.load('client', async () => {
        await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
        checkPersistentLogin();
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: async (resp) => {
            if (resp.error) return;
            accessToken = resp.access_token;
            localStorage.setItem('at_token', accessToken);
            localStorage.setItem('at_expiry', Date.now() + 3500000); // 1hr
            gapi.client.setToken({ access_token: accessToken });
            loadProfile();
        }
    });
    gisInited = true;
}

function checkPersistentLogin() {
    const savedToken = localStorage.getItem('at_token');
    const expiry = localStorage.getItem('at_expiry');
    if (savedToken && expiry && Date.now() < parseInt(expiry)) {
        accessToken = savedToken;
        gapi.client.setToken({ access_token: accessToken });
        loadProfile();
    }
}

function logout() {
    localStorage.clear();
    location.reload();
}

/**
 * 3. ROUTING & DATA FETCHING
 */
async function loadProfile() {
    showLoader(true);
    try {
        const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const info = await resp.json();
        const email = info.email.toLowerCase();

        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('user-badge').classList.remove('hidden');
        document.getElementById('logout-btn').classList.remove('hidden');
        document.getElementById('user-display-name').innerText = info.name || email;

        if (email === OWNER_EMAIL.toLowerCase()) {
            document.getElementById('admin-switch-btn').classList.remove('hidden');
        }

        // Landing Page is always Staff View
        setupStaffView(email);
    } catch (e) { logout(); }
    showLoader(false);
}

function switchView(view) {
    const sv = document.getElementById('staff-view');
    const av = document.getElementById('admin-view');
    if (view === 'admin') {
        sv.classList.add('hidden');
        av.classList.remove('hidden');
        renderManager('stores');
        loadAdminStats();
    } else {
        av.classList.add('hidden');
        sv.classList.remove('hidden');
    }
}

/**
 * 4. STAFF LANDING PAGE LOGIC
 */
async function setupStaffView(email) {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D'
        });
        const rows = resp.result.values || [];
        const emp = rows.find(r => r[0].toLowerCase() === email);

        if (!emp) {
            if (email === OWNER_EMAIL.toLowerCase()) { switchView('admin'); return; }
            alert("Email not registered in Staff list."); return;
        }

        currentUser = { email: emp[0], name: emp[1], storeName: emp[2] };
        document.getElementById('staff-welcome').innerText = `Hello, ${currentUser.name}!`;
        document.getElementById('staff-view').classList.remove('hidden');
        
        // Find Store GPS
        const storeResp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D'
        });
        const sData = (storeResp.result.values || []).find(s => s[1] === currentUser.storeName);
        if (sData) currentStoreData = { lat: parseFloat(sData[2]), lng: parseFloat(sData[3]) };
        
        document.getElementById('staff-store-tag').innerText = `Location: ${currentUser.storeName}`;
        checkTodayAttendance();
        loadPersonalHistory(email);
        setupCamera();
    } catch (e) { 
        if(email === OWNER_EMAIL.toLowerCase()) {
            document.getElementById('setup-card').classList.remove('hidden');
            switchView('admin');
        }
    }
}

/**
 * 5. ATTENDANCE & PUNCH LOGIC
 */
async function checkTodayAttendance() {
    const today = new Date().toLocaleDateString();
    const resp = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A2:D'
    });
    const history = resp.result.values || [];
    const userToday = history.filter(r => r[1] === today && r[2] === currentUser.email);
    
    const badge = document.getElementById('status-badge');
    if (userToday.some(r => r[3] === 'IN') && userToday.some(r => r[3] === 'OUT')) {
        badge.innerText = "Completed"; badge.className = "bg-emerald-500 text-white px-3 py-1 rounded-full text-[10px] font-black";
        document.getElementById('attendance-box').innerHTML = `<p class="text-center py-10 font-bold text-slate-400">Shift finished for today!</p>`;
    } else if (userToday.some(r => r[3] === 'IN')) {
        badge.innerText = "Shift Started"; badge.className = "bg-orange-500 text-white px-3 py-1 rounded-full text-[10px] font-black";
        document.getElementById('punch-in-btn').classList.add('hidden');
    }
}

async function handlePunch(action) {
    showLoader(true);
    const timeResp = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC').then(r => r.json()).catch(() => ({datetime: new Date().toISOString()}));
    const timestamp = timeResp.datetime;
    const date = new Date(timestamp).toLocaleDateString();
    const gps = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res(`${p.coords.latitude},${p.coords.longitude}`), () => res("No GPS")));

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[timestamp, date, currentUser.email, action, staffPhoto, gps, navigator.userAgent.slice(0, 20)]] }
        });
        showToast("Success!", "success");
        setTimeout(() => location.reload(), 2000);
    } catch (e) { showToast("Save Failed", "error"); }
    showLoader(false);
}

/**
 * 6. SMART MANAGER & ADMIN LOGIC
 */
async function renderManager(mode) {
    const cont = document.getElementById('manager-content');
    cont.innerHTML = `<div class="flex justify-center py-12"><div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div></div>`;
    
    try {
        if (mode === 'stores') {
            const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D' });
            const list = resp.result.values || [];
            cont.innerHTML = `
                <div class="space-y-6">
                    <div class="space-y-3 bg-slate-50 p-4 rounded-2xl">
                        <input id="m-s-n" placeholder="Store Name" class="w-full p-3 rounded-xl text-sm">
                        <div class="flex gap-2">
                            <input id="m-s-lat" placeholder="Lat" class="w-1/2 p-3 rounded-xl text-sm">
                            <input id="m-s-lng" placeholder="Lng" class="w-1/2 p-3 rounded-xl text-sm">
                        </div>
                        <button onclick="adminAddStore()" class="w-full bg-indigo-600 text-white py-3 rounded-xl text-xs font-bold">ADD NEW STORE</button>
                    </div>
                    <div class="space-y-2">
                        ${list.map((s, i) => `<div class="flex justify-between p-3 bg-white border rounded-xl text-xs"><span><b>${s[1]}</b></span><button onclick="adminDeleteRow('Stores', ${i+2})" class="text-rose-500 font-bold">DELETE</button></div>`).join('')}
                    </div>
                </div>`;
        } else {
            const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D' });
            const storesResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!B2:B' });
            const list = resp.result.values || [];
            const stores = storesResp.result.values || [];
            cont.innerHTML = `
                <div class="space-y-6">
                    <div class="space-y-3 bg-slate-50 p-4 rounded-2xl">
                        <input id="m-e-e" placeholder="Google Email" class="w-full p-3 rounded-xl text-sm">
                        <input id="m-e-n" placeholder="Full Name" class="w-full p-3 rounded-xl text-sm">
                        <select id="m-e-s" class="w-full p-3 rounded-xl text-sm">${stores.map(s => `<option value="${s[0]}">${s[0]}</option>`).join('')}</select>
                        <button onclick="adminAddEmployee()" class="w-full bg-slate-900 text-white py-3 rounded-xl text-xs font-bold">REGISTER STAFF</button>
                    </div>
                    <div class="space-y-2">
                        ${list.map((e, i) => `<div class="flex justify-between p-3 bg-white border rounded-xl text-[10px]"><span><b>${e[1]}</b> (${e[2]})</span><button onclick="adminDeleteRow('Employees', ${i+2})" class="text-rose-500 font-bold uppercase">Remove</button></div>`).join('')}
                    </div>
                </div>`;
        }
    } catch (e) { cont.innerHTML = `<p class="text-center text-rose-500 text-xs py-10">Run "Smart Sync" to prepare the manager.</p>`; }
}

async function adminAddStore() {
    const n = document.getElementById('m-s-n').value, lt = document.getElementById('m-s-lat').value, lg = document.getElementById('m-s-lng').value;
    if(!n || !lt || !lg) return;
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Stores!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[Date.now(), n, lt, lg]] }
    });
    renderManager('stores');
}

async function adminAddEmployee() {
    const em = document.getElementById('m-e-e').value.toLowerCase(), nm = document.getElementById('m-e-n').value, st = document.getElementById('m-e-s').value;
    if(!em || !nm || !st) return;
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[em, nm, st, 'Active']] }
    });
    renderManager('employees');
}

async function adminDeleteRow(tab, idx) {
    if(!confirm("Delete this record?")) return;
    showLoader(true);
    const ss = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sId = ss.result.sheets.find(s => s.properties.title === tab).properties.sheetId;
    await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ deleteDimension: { range: { sheetId: sId, dimension: 'ROWS', startIndex: idx-1, endIndex: idx } } }] }
    });
    showLoader(false);
    renderManager(tab.toLowerCase());
}

/**
 * 7. SMART SYNC (FIXED: NO CRASH)
 */
async function initializeSheetStructure() {
    showLoader(true);
    try {
        const ssMeta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const existing = ssMeta.result.sheets.map(s => s.properties.title);
        const required = ['Stores', 'Employees', 'Attendance'];
        const missing = required.filter(t => !existing.includes(t));

        if (missing.length > 0) {
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: missing.map(t => ({ addSheet: { properties: { title: t } } })) }
            });
        }

        const hRequests = [
            { range: 'Stores!A1:D1', values: [['ID', 'Name', 'Lat', 'Lng']] },
            { range: 'Employees!A1:D1', values: [['Email', 'Name', 'StoreName', 'Status']] },
            { range: 'Attendance!A1:G1', values: [['Timestamp', 'Date', 'Email', 'Action', 'Photo', 'GPS', 'Device']] }
        ];

        for (let h of hRequests) {
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: h.range,
                valueInputOption: 'USER_ENTERED', resource: { values: h.values }
            });
        }
        showToast("Sync Complete!", "success");
        document.getElementById('setup-card').classList.add('hidden');
        location.reload();
    } catch (e) { alert("Sync Error: " + (e.result?.error?.message || "Check Permissions")); }
    showLoader(false);
}

/**
 * 8. GEOFENCING & CAMERA
 */
async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        document.getElementById('video').srcObject = stream;
    } catch (e) { showToast("Camera Access Denied", "error"); }
}

document.getElementById('capture-btn').onclick = () => {
    const canvas = document.getElementById('canvas'), video = document.getElementById('video');
    canvas.width = 300; canvas.height = 300;
    canvas.getContext('2d').drawImage(video, 0, 0, 300, 300);
    staffPhoto = canvas.toDataURL('image/jpeg', 0.5);
    document.getElementById('photo-preview').src = staffPhoto;
    document.getElementById('photo-preview').classList.remove('hidden');
    verifyLocation();
};

function verifyLocation() {
    navigator.geolocation.getCurrentPosition(pos => {
        const dist = calcDist(pos.coords.latitude, pos.coords.longitude, currentStoreData.lat, currentStoreData.lng);
        const status = document.getElementById('geofence-status');
        if (dist <= 0.15) { // 150m
            document.querySelectorAll('#punch-in-btn, #punch-out-btn').forEach(b => { b.disabled = false; b.classList.remove('opacity-40'); });
            status.innerText = "📍 LOCATION VERIFIED"; status.className = "mb-4 text-center py-3 bg-emerald-50 rounded-2xl text-[10px] font-bold text-emerald-600";
        } else {
            status.innerText = "❌ OUTSIDE STORE RANGE"; status.className = "mb-4 text-center py-3 bg-rose-50 rounded-2xl text-[10px] font-bold text-rose-600";
        }
    }, () => showToast("Enable GPS", "error"));
}

function calcDist(la1, lo1, la2, lo2) {
    const R = 6371;
    const dLa = (la2-la1)*Math.PI/180, dLo = (lo2-lo1)*Math.PI/180;
    const a = Math.sin(dLa/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Utils
function showLoader(s) { document.getElementById('loader').classList.toggle('hidden', !s); }
function showToast(m, t) {
    const el = document.createElement('div'); el.className = `toast ${t}`; el.innerText = m;
    document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}

window.onload = initializeApp;
document.getElementById('login-btn').onclick = () => tokenClient.requestAccessToken();
document.getElementById('punch-in-btn').onclick = () => handlePunch('IN');
document.getElementById('punch-out-btn').onclick = () => handlePunch('OUT');