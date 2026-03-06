/**
 * 1. CONFIGURATION
 */
const CLIENT_ID = '747138722746-5moie20nkh3hgpkrhfb4gmvmkiadjbku.apps.googleusercontent.com';
const API_KEY = 'AIzaSyA3v6zEyQhRq8X-PW0HG1eqhdmk8wbSg8s';
const SPREADSHEET_ID = '1UpHxRuvfYWguE78__bYR2sfjxRn6sskqOa5Po7XUoCU';
const OWNER_EMAIL = 'krishnahospitalsapotra@gmail.com'; // Admin account

const DISCOVERY_DOC = 'https://sheets.googleapis.com/$discovery/rest?version=v4';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

let tokenClient, accessToken = null, gapiInited = false, gisInited = false;
let currentUser = null, currentStoreData = null, staffPhoto = null;

/**
 * 2. CORE INITIALIZATION
 */
async function initializeApp() {
    console.log("Pro-Attend: Starting Initialization...");
    
    // Load GAPI
    gapi.load('client', async () => {
        try {
            await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
            gapiInited = true;
            console.log("GAPI Ready");
            checkPersistentSession();
        } catch (e) {
            console.error("GAPI Init Error:", e);
        }
    });

    // Load GIS
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (resp) => {
            if (resp.error) {
                alert("Auth Failed: " + resp.error);
                return;
            }
            accessToken = resp.access_token;
            localStorage.setItem('at_token', accessToken);
            localStorage.setItem('at_expiry', Date.now() + 3500000);
            gapi.client.setToken({ access_token: accessToken });
            loadProfile();
        }
    });
    gisInited = true;
}

function checkPersistentSession() {
    const saved = localStorage.getItem('at_token');
    const expiry = localStorage.getItem('at_expiry');
    if (saved && expiry && Date.now() < parseInt(expiry)) {
        accessToken = saved;
        gapi.client.setToken({ access_token: accessToken });
        loadProfile();
    } else {
        showLoader(false);
        document.getElementById('login-view').classList.remove('hidden');
    }
}

function logout() {
    localStorage.clear();
    location.reload();
}

/**
 * 3. PROFILE & NAVIGATION
 */
async function loadProfile() {
    showLoader(true);
    try {
        const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const info = await resp.json();
        const email = info.email.toLowerCase();

        // Reveal Nav Elements
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('user-badge').classList.remove('hidden');
        document.getElementById('logout-btn').classList.remove('hidden');
        document.getElementById('user-display-name').innerText = info.name || email;

        if (email === OWNER_EMAIL.toLowerCase()) {
            document.getElementById('admin-switch-btn').classList.remove('hidden');
        }

        // Landing Page is Always Staff Dashboard
        setupStaffDashboard(email);
    } catch (e) {
        console.error("Profile Error:", e);
        logout();
    }
}

function switchView(view) {
    if (view === 'admin') {
        document.getElementById('staff-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        renderSmartManager('stores');
        loadAdminStats();
    } else {
        document.getElementById('admin-view').classList.add('hidden');
        document.getElementById('staff-view').classList.remove('hidden');
    }
}

/**
 * 4. DATABASE AUTOMATION (SMART SYNC)
 */
async function initializeSheetStructure() {
    showLoader(true);
    try {
        // 1. Check what sheets actually exist
        const ss = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const existing = ss.result.sheets.map(s => s.properties.title);
        
        const required = ['Stores', 'Employees', 'Attendance'];
        const missing = required.filter(t => !existing.includes(t));

        // 2. Only create the missing ones
        if (missing.length > 0) {
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: missing.map(t => ({ addSheet: { properties: { title: t } } })) }
            });
        }

        // 3. Update all headers (Safe to repeat)
        const headers = [
            { range: 'Stores!A1:D1', values: [['ID', 'Name', 'Lat', 'Lng']] },
            { range: 'Employees!A1:D1', values: [['Email', 'Name', 'StoreName', 'Status']] },
            { range: 'Attendance!A1:G1', values: [['Timestamp', 'Date', 'Email', 'Action', 'Photo', 'GPS', 'Device']] }
        ];

        for (const h of headers) {
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: h.range,
                valueInputOption: 'USER_ENTERED', resource: { values: h.values }
            });
        }

        showToast("Database Synced!", "success");
        document.getElementById('setup-card').classList.add('hidden');
        setTimeout(() => location.reload(), 1500);

    } catch (e) {
        const msg = e.result?.error?.message || "Verify Google Cloud Scope Settings";
        alert("Sync Error: " + msg);
    }
    showLoader(false);
}

/**
 * 5. STAFF SECTION LOGIC
 */
async function setupStaffDashboard(email) {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D'
        });
        const rows = resp.result.values || [];
        const emp = rows.find(r => r[0].toLowerCase() === email);

        if (!emp) {
            if (email === OWNER_EMAIL.toLowerCase()) {
                switchView('admin');
                return;
            }
            alert("Email not registered in Staff list.");
            return;
        }

        currentUser = { email: emp[0], name: emp[1], storeName: emp[2] };
        document.getElementById('staff-welcome').innerText = `Hello, ${currentUser.name}!`;
        document.getElementById('staff-store-tag').innerText = `Home Store: ${currentUser.storeName}`;
        document.getElementById('staff-view').classList.remove('hidden');

        // Geofence Load
        const stResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D' });
        const stData = (stResp.result.values || []).find(s => s[1] === currentUser.storeName);
        if (stData) currentStoreData = { lat: parseFloat(stData[2]), lng: parseFloat(stData[3]) };

        setupCamera();
        checkTodayStatus();
    } catch (e) {
        if (email === OWNER_EMAIL.toLowerCase()) {
            document.getElementById('setup-card').classList.remove('hidden');
            switchView('admin');
        }
    }
}

async function checkTodayStatus() {
    const today = new Date().toLocaleDateString();
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A2:D' });
        const rows = (resp.result.values || []).filter(r => r[1] === today && r[2] === currentUser.email);
        
        if (rows.some(r => r[3] === 'IN') && rows.some(r => r[3] === 'OUT')) {
            document.getElementById('attendance-box').innerHTML = `<p class="text-center py-10 font-bold text-emerald-600">Day Completed! ✅</p>`;
        } else if (rows.some(r => r[3] === 'IN')) {
            document.getElementById('punch-in-btn').classList.add('hidden');
            document.getElementById('geofence-status').innerText = "STATUS: PUNCHED IN";
        }
    } catch (e) {}
}

async function handlePunch(action) {
    showLoader(true);
    const time = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC').then(r => r.json()).then(d => d.datetime).catch(() => new Date().toISOString());
    const date = new Date(time).toLocaleDateString();
    const gps = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res(`${p.coords.latitude},${p.coords.longitude}`), () => res("No GPS")));

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[time, date, currentUser.email, action, staffPhoto, gps, navigator.platform]] }
        });
        showToast(`Attendance Marked: ${action}`, "success");
        setTimeout(() => location.reload(), 2000);
    } catch (e) { showToast("Save Error", "error"); }
    showLoader(false);
}

/**
 * 6. SMART MANAGER (ADMIN)
 */
async function renderSmartManager(type) {
    const container = document.getElementById('manager-content');
    container.innerHTML = `<div class="flex justify-center p-10"><div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div></div>`;
    
    try {
        if (type === 'stores') {
            const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A2:D' });
            const list = resp.result.values || [];
            container.innerHTML = `
                <div class="space-y-4">
                    <div class="bg-indigo-50 p-4 rounded-2xl space-y-2">
                        <input id="mgr-st-n" placeholder="Store Name" class="w-full p-2 rounded-lg text-sm border">
                        <input id="mgr-st-lat" placeholder="Latitude" class="w-full p-2 rounded-lg text-sm border">
                        <input id="mgr-st-lng" placeholder="Longitude" class="w-full p-2 rounded-lg text-sm border">
                        <button onclick="adminSaveStore()" class="w-full bg-indigo-600 text-white py-2 rounded-lg font-bold text-xs">SAVE STORE</button>
                    </div>
                    ${list.map((s, i) => `<div class="flex justify-between p-3 bg-white border rounded-xl text-xs"><span><b>${s[1]}</b></span><button onclick="adminDeleteRow('Stores', ${i+2})" class="text-rose-500 font-bold">DEL</button></div>`).join('')}
                </div>`;
        } else {
            const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A2:D' });
            const stResp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!B2:B' });
            const list = resp.result.values || [];
            const stores = stResp.result.values || [];
            container.innerHTML = `
                <div class="space-y-4">
                    <div class="bg-slate-50 p-4 rounded-2xl space-y-2">
                        <input id="mgr-em-e" placeholder="Google Email" class="w-full p-2 rounded-lg text-sm border">
                        <input id="mgr-em-n" placeholder="Full Name" class="w-full p-2 rounded-lg text-sm border">
                        <select id="mgr-em-s" class="w-full p-2 rounded-lg text-sm border">${stores.map(s => `<option value="${s[0]}">${s[0]}</option>`).join('')}</select>
                        <button onclick="adminSaveEmployee()" class="w-full bg-slate-900 text-white py-2 rounded-lg font-bold text-xs">SAVE STAFF</button>
                    </div>
                    ${list.map((e, i) => `<div class="flex justify-between p-3 bg-white border rounded-xl text-[10px]"><span><b>${e[1]}</b> (${e[2]})</span><button onclick="adminDeleteRow('Employees', ${i+2})" class="text-rose-500 font-bold">REMOVE</button></div>`).join('')}
                </div>`;
        }
    } catch (e) { container.innerHTML = `<p class="text-center text-rose-500 text-xs py-10 font-bold">Run Database Sync First</p>`; }
}

async function adminSaveStore() {
    const n = document.getElementById('mgr-st-n').value, lt = document.getElementById('mgr-st-lat').value, lg = document.getElementById('mgr-st-lng').value;
    if(!n || !lt || !lg) return;
    await gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Stores!A:D', valueInputOption: 'USER_ENTERED', resource: { values: [[Date.now(), n, lt, lg]] } });
    renderSmartManager('stores');
}

async function adminSaveEmployee() {
    const e = document.getElementById('mgr-em-e').value, n = document.getElementById('mgr-em-n').value, s = document.getElementById('mgr-em-s').value;
    if(!e || !n || !s) return;
    await gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D', valueInputOption: 'USER_ENTERED', resource: { values: [[e.toLowerCase(), n, s, 'Active']] } });
    renderSmartManager('employees');
}

async function adminDeleteRow(tab, idx) {
    if(!confirm("Delete this?")) return;
    showLoader(true);
    const ss = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sId = ss.result.sheets.find(s => s.properties.title === tab).properties.sheetId;
    await gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ deleteDimension: { range: { sheetId: sId, dimension: 'ROWS', startIndex: idx-1, endIndex: idx } } }] } });
    showLoader(false);
    renderSmartManager(tab.toLowerCase());
}

/**
 * 7. GEOFENCING & CAMERA
 */
async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        document.getElementById('video').srcObject = stream;
    } catch (e) { showToast("Camera Access Error", "error"); }
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
        if (dist <= 0.2) { // 200 Meters
            document.querySelectorAll('#punch-in-btn, #punch-out-btn').forEach(b => { b.disabled = false; b.classList.remove('opacity-40'); });
            status.innerText = "📍 LOCATION VERIFIED"; status.className = "mb-4 text-center py-3 bg-emerald-50 rounded-2xl text-[10px] font-bold text-emerald-600";
        } else {
            status.innerText = "❌ OUTSIDE STORE RANGE"; status.className = "mb-4 text-center py-3 bg-rose-50 rounded-2xl text-[10px] font-bold text-rose-600";
        }
    }, () => showToast("GPS Permission Denied", "error"