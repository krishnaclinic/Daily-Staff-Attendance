// --- 1. CONFIGURATION ---
const CLIENT_ID = '747138722746-5moie20nkh3hgpkrhfb4gmvmkiadjbku.apps.googleusercontent.com';
const API_KEY = 'AIzaSyA3v6zEyQhRq8X-PW0HG1eqhdmk8wbSg8s';
const SPREADSHEET_ID = '1UpHxRuvfYWguE78__bYR2sfjxRn6sskqOa5Po7XUoCU';
const OWNER_EMAIL = 'krishnahospitalsapotra@gmail.com'; // Admin account

const DISCOVERY_DOC = 'https://sheets.googleapis.com/$discovery/rest?version=v4';
//const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

let tokenClient, gisInited = false, gapiInited = false, accessToken = null;
let currentUser = null, currentStoreData = null, staffPhoto = null;

// --- 2. INITIALIZATION ---

async function initializeApp() {
    gapi.load('client', async () => {
        await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
        autoLogin();
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: async (resp) => {
            if (resp.error) return;
            accessToken = resp.access_token;
            localStorage.setItem('at_token', accessToken);
            localStorage.setItem('at_expiry', Date.now() + 3500000);
            gapi.client.setToken({ access_token: accessToken });
            loadProfile();
        }
    });
    gisInited = true;
}

function autoLogin() {
    const savedToken = localStorage.getItem('at_token');
    const expiry = localStorage.getItem('at_expiry');
    if (savedToken && expiry && Date.now() < parseInt(expiry)) {
        accessToken = savedToken;
        gapi.client.setToken({ access_token: accessToken });
        loadProfile();
    }
}

// --- 3. DATABASE AUTOMATION ---

async function initializeSheetStructure() {
    showLoader(true);
    try {
        const tabs = ['Stores', 'Employees', 'Attendance'];
        const requests = tabs.map(title => ({ addSheet: { properties: { title } } }));
        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID, resource: { requests }
        });

        const headerData = [
            { range: 'Stores!A1:D1', values: [['ID', 'Name', 'Lat', 'Lng']] },
            { range: 'Employees!A1:D1', values: [['Email', 'Name', 'StoreName', 'Status']] },
            { range: 'Attendance!A1:F1', values: [['Timestamp', 'Date', 'Email', 'Action', 'Photo', 'GPS']] }
        ];

        for (let h of headerData) {
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: h.range,
                valueInputOption: 'USER_ENTERED', resource: { values: h.values }
            });
        }
        showToast("Database Ready!", "success");
        setupAdminDashboard();
    } catch (e) { showToast("Initialization Failed", "error"); }
    showLoader(false);
}

// --- 4. PROFILE & ROUTING ---

async function loadProfile() {
    showLoader(true);
    try {
        const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userInfo = await resp.json();
        
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('user-badge').classList.remove('hidden');
        document.getElementById('user-display-name').innerText = userInfo.name || userInfo.email;

        if (userInfo.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
            setupAdminDashboard();
        } else {
            setupStaffDashboard(userInfo.email);
        }
    } catch (e) {
        localStorage.clear();
        document.getElementById('login-view').classList.remove('hidden');
    }
    showLoader(false);
}

async function setupAdminDashboard() {
    document.getElementById('admin-view').classList.remove('hidden');
    try {
        await loadAdminStats();
        await loadStoresDropdown();
        document.getElementById('setup-card').classList.add('hidden');
    } catch (e) {
        document.getElementById('setup-card').classList.remove('hidden');
    }
}

async function setupStaffDashboard(email) {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:C'
        });
        const rows = resp.result.values || [];
        const emp = rows.find(r => r[0].toLowerCase() === email.toLowerCase());

        if (!emp) { alert("Access Denied: Email not registered."); return; }

        currentUser = { email: emp[0], name: emp[1], storeName: emp[2] };
        document.getElementById('staff-welcome').innerText = `Hello, ${currentUser.name}!`;
        document.getElementById('staff-store-tag').innerText = currentUser.storeName;
        document.getElementById('staff-view').classList.remove('hidden');

        const storeResp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D'
        });
        const sRow = (storeResp.result.values || []).find(s => s[1] === currentUser.storeName);
        currentStoreData = { lat: parseFloat(sRow[2]), lng: parseFloat(sRow[3]) };

        checkTodayAttendance();
        setupCamera();
        checkOfflineQueue();
    } catch (e) { showToast("Error loading staff data", "error"); }
}

// --- 5. ATTENDANCE CORE LOGIC ---

async function checkTodayAttendance() {
    const today = new Date().toLocaleDateString();
    const resp = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A2:D'
    });
    const history = resp.result.values || [];
    const userToday = history.filter(r => r[1] === today && r[2] === currentUser.email);
    
    if (userToday.some(r => r[3] === 'IN') && userToday.some(r => r[3] === 'OUT')) {
        document.getElementById('attendance-box').classList.add('hidden');
        document.getElementById('completed-msg').classList.remove('hidden');
    } else if (userToday.some(r => r[3] === 'IN')) {
        document.getElementById('punch-in-btn').classList.add('hidden');
        document.getElementById('status-display').innerText = "Status: Punched In. Please Punch Out later.";
    }
}

async function handlePunch(action) {
    showLoader(true);
    // Anti-Tamper Time
    const verifiedTime = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC')
        .then(r => r.json()).then(d => d.datetime).catch(() => new Date().toISOString());

    const gps = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res(`${p.coords.latitude},${p.coords.longitude}`)));
    
    const entry = [verifiedTime, new Date(verifiedTime).toLocaleDateString(), currentUser.email, action, staffPhoto, gps];

    if (navigator.onLine) {
        try {
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F',
                valueInputOption: 'USER_ENTERED', resource: { values: [entry] }
            });
            showToast(`Punched ${action} Successfully!`, "success");
            setTimeout(() => location.reload(), 2000);
        } catch (e) { saveOffline(entry); }
    } else {
        saveOffline(entry);
    }
    showLoader(false);
}

// --- 6. GEOFENCING & SECURITY ---

async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    document.getElementById('video').srcObject = stream;
}

document.getElementById('capture-btn').onclick = () => {
    const canvas = document.getElementById('canvas');
    const video = document.getElementById('video');
    canvas.width = 300; canvas.height = 300;
    canvas.getContext('2d').drawImage(video, 0, 0, 300, 300);
    staffPhoto = canvas.toDataURL('image/jpeg', 0.5);
    document.getElementById('photo-preview').src = staffPhoto;
    document.getElementById('photo-preview').classList.remove('hidden');
    
    document.getElementById('status-display').innerText = "Verifying Location...";
    verifyGeofence();
};

function verifyGeofence() {
    navigator.geolocation.getCurrentPosition(pos => {
        const dist = calcDist(pos.coords.latitude, pos.coords.longitude, currentStoreData.lat, currentStoreData.lng);
        if (dist <= 0.15) { // 150 meters
            document.querySelectorAll('#punch-controls button').forEach(b => {
                b.disabled = false; b.classList.remove('opacity-50');
            });
            document.getElementById('status-display').innerText = "📍 Verified! You are at the store.";
            document.getElementById('status-display').className = "bg-emerald-50 p-4 rounded-2xl mb-4 text-sm font-bold text-emerald-600";
        } else {
            showToast("Too far from store!", "error");
            document.getElementById('status-display').innerText = "❌ Verification Failed: Outside Range";
        }
    }, () => showToast("Enable GPS to punch in", "error"));
}

function calcDist(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- 7. OFFLINE QUEUE LOGIC ---

function saveOffline(entry) {
    const queue = JSON.parse(localStorage.getItem('offline_punc') || '[]');
    queue.push(entry);
    localStorage.setItem('offline_punc', JSON.stringify(queue));
    showToast("Offline: Data saved locally", "error");
    checkOfflineQueue();
}

function checkOfflineQueue() {
    const queue = JSON.parse(localStorage.getItem('offline_punc') || '[]');
    document.getElementById('sync-btn').classList.toggle('hidden', queue.length === 0);
}

async function syncOfflineData() {
    const queue = JSON.parse(localStorage.getItem('offline_punc') || '[]');
    showLoader(true);
    try {
        for (let entry of queue) {
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:F',
                valueInputOption: 'USER_ENTERED', resource: { values: [entry] }
            });
        }
        localStorage.removeItem('offline_punc');
        showToast("Offline data synced!", "success");
        setTimeout(() => location.reload(), 1500);
    } catch (e) { showToast("Sync failed. Still offline?", "error"); }
    showLoader(false);
}

// --- 8. ADMIN HELPERS ---

async function registerStore() {
    const n = document.getElementById('adm-store-name').value.trim();
    const lt = document.getElementById('adm-store-lat').value.trim();
    const lg = document.getElementById('adm-store-lng').value.trim();
    if(!n || !lt || !lg) return showToast("Fill all fields", "error");
    
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Stores!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[Date.now(), n, lt, lg]] }
    });
    showToast("Store Saved!", "success");
    setupAdminDashboard();
}

async function registerEmployee() {
    const e = document.getElementById('adm-emp-email').value.trim().toLowerCase();
    const n = document.getElementById('adm-emp-name').value.trim();
    const s = document.getElementById('adm-emp-store').value;
    if(!e || !n || !s) return showToast("Fill all fields", "error");

    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [[e, n, s, 'Active']] }
    });
    showToast("Staff Registered!", "success");
    setupAdminDashboard();
}

async function loadAdminStats() {
    const storeResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:A' });
    const staffResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:A' });
    const attResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!B2:B' });
    
    const today = new Date().toLocaleDateString();
    const presentCount = (attResp.result.values || []).filter(v => v[0] === today).length;

    document.getElementById('count-stores').innerText = (storeResp.result.values || []).length;
    document.getElementById('count-staff').innerText = (staffResp.result.values || []).length;
    document.getElementById('count-present').innerText = presentCount;
}

async function loadStoresDropdown() {
    const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!B2:B' });
    const stores = resp.result.values || [];
    const dd = document.getElementById('adm-emp-store');
    dd.innerHTML = '<option value="">-- Select Store --</option>';
    stores.forEach(s => dd.innerHTML += `<option value="${s[0]}">${s[0]}</option>`);
}

function showLoader(s) { document.getElementById('loader').classList.toggle('hidden', !s); }
function showToast(m, t) {
    const el = document.createElement('div'); el.className = `toast ${t}`; el.innerText = m;
    document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}

window.onload = initializeApp;
document.getElementById('login-btn').onclick = () => tokenClient.requestAccessToken();
document.getElementById('punch-in-btn').onclick = () => handlePunch('IN');
document.getElementById('punch-out-btn').onclick = () => handlePunch('OUT');